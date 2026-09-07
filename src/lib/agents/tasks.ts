/**
 * Task orchestration records. Creating and progressing a task is normal
 * day-to-day use of the AI workforce, not administration — unlike agents.ts,
 * nothing here is role-gated. What every function does enforce is tenant
 * isolation: an agent, a parent task, or a task being updated must belong to
 * the calling workspace, or the lookup fails exactly as if it didn't exist.
 */
import { db } from '../db';
import { enqueue } from '../queue';
import { logActivity } from './activity';
import { parsePriority, parseTaskStatus } from './validation';
import { TaskStatus } from '@/generated/prisma/enums';
import type { Prisma } from '@/generated/prisma/client';

/** Statuses a task can still be moved out of by a cancel request. */
const CANCELLABLE_STATUSES: string[] = [
  TaskStatus.Queued, TaskStatus.Thinking, TaskStatus.Working, TaskStatus.WaitingForApproval, TaskStatus.WaitingForInput,
];

/** Hard ceiling on agent-to-agent delegation chains — see docs/prompts for the collaboration rules this backs. */
export const MAX_TASK_DEPTH = 5;

export type CreateTaskInput = {
  agentId: string;
  parentTaskId?: string | null;
  title: string;
  description?: string | null;
  priority?: number;
  input?: unknown;
  relatedRecordIds?: string[];
  createdBy?: string | null;
  maxRetries?: number;
  /**
   * Defaults to true (unchanged behavior for every existing caller). Pass
   * false for a task that must not run yet — a pure bookkeeping node (the
   * Command Center's root task, which never has toolCalls to execute), or a
   * planned step still waiting on a dependency (src/lib/agents/
   * commandCenter.ts enqueues it once that dependency actually completes).
   */
  enqueue?: boolean;
};

async function taskDepth(taskId: string): Promise<number> {
  let depth = 1;
  let current = await db.agentTask.findUnique({ where: { id: taskId }, select: { parentTaskId: true } });
  // 50 is a hard stop against a corrupt/cyclic chain, never expected to bind in practice given MAX_TASK_DEPTH.
  while (current?.parentTaskId && depth < 50) {
    depth++;
    current = await db.agentTask.findUnique({ where: { id: current.parentTaskId }, select: { parentTaskId: true } });
  }
  return depth;
}

export async function createTask(workspaceId: string, data: CreateTaskInput) {
  const title = data.title.trim();
  if (!title) throw new Error('Title is required.');
  const priority = data.priority !== undefined ? parsePriority(data.priority) : undefined;

  const agent = await db.agent.findFirst({ where: { id: data.agentId, workspaceId } });
  if (!agent) throw new Error('Agent not found in this workspace.');

  if (data.parentTaskId) {
    const parent = await db.agentTask.findFirst({ where: { id: data.parentTaskId, workspaceId } });
    if (!parent) throw new Error('Parent task not found in this workspace.');
    const depth = await taskDepth(parent.id);
    if (depth >= MAX_TASK_DEPTH) {
      throw new Error(`Delegation depth limit (${MAX_TASK_DEPTH}) reached — cannot create a deeper sub-task.`);
    }
  }

  const task = await db.agentTask.create({
    data: {
      workspaceId,
      agentId: data.agentId,
      parentTaskId: data.parentTaskId ?? null,
      title,
      description: data.description ?? null,
      ...(priority !== undefined ? { priority } : {}),
      input: (data.input ?? null) as Prisma.InputJsonValue,
      relatedRecordIds: (data.relatedRecordIds ?? []) as Prisma.InputJsonValue,
      createdBy: data.createdBy ?? null,
      ...(data.maxRetries !== undefined ? { maxRetries: data.maxRetries } : {}),
    },
  });

  await logActivity(workspaceId, { agentId: task.agentId, taskId: task.id, type: 'task_created' });
  // Every task is created Queued; by default it's handed straight to the
  // same worker/Job queue every other background operation already runs
  // through. data.enqueue === false leaves it Queued-but-un-jobbed —
  // whoever creates it that way is responsible for enqueueing it later.
  if (data.enqueue !== false) {
    await enqueue(workspaceId, 'run_agent_task', { taskId: task.id });
  }

  return task;
}

/** Gives a task created with enqueue:false its Job now that it's actually ready to run. */
export async function enqueueTask(workspaceId: string, taskId: string) {
  const task = await db.agentTask.findFirst({ where: { id: taskId, workspaceId } });
  if (!task) throw new Error('Task not found in this workspace.');
  if (task.status !== TaskStatus.Queued) return; // already running/resolved — nothing to do
  await enqueue(workspaceId, 'run_agent_task', { taskId });
}

/**
 * One task creating another, on behalf of the same or a different agent.
 * Depth limiting is inherited from createTask() — this is purely the
 * bookkeeping layer: it exists so the handoff itself is a real, logged event
 * distinct from "an agent happened to create a task with a parentTaskId".
 */
export async function delegateTask(workspaceId: string, parentTaskId: string, data: Omit<CreateTaskInput, 'parentTaskId'>) {
  const parent = await db.agentTask.findFirst({ where: { id: parentTaskId, workspaceId } });
  if (!parent) throw new Error('Parent task not found in this workspace.');

  const child = await createTask(workspaceId, { ...data, parentTaskId });
  await logActivity(workspaceId, {
    agentId: parent.agentId, taskId: parent.id,
    type: 'delegation_created', meta: { childTaskId: child.id, toAgentId: data.agentId },
  });
  return child;
}

/** Refuses to "cancel" a task that has already reached a terminal state. */
export async function cancelTask(workspaceId: string, taskId: string) {
  const task = await db.agentTask.findFirst({ where: { id: taskId, workspaceId } });
  if (!task) throw new Error('Task not found in this workspace.');
  if (!CANCELLABLE_STATUSES.includes(task.status)) {
    throw new Error(`Cannot cancel a task that is already ${task.status}.`);
  }
  const cancelled = await db.agentTask.update({ where: { id: taskId }, data: { status: TaskStatus.Cancelled } });
  await logActivity(workspaceId, { agentId: task.agentId, taskId: task.id, type: 'task_cancelled' });
  return cancelled;
}

export async function getTask(workspaceId: string, taskId: string) {
  return db.agentTask.findFirst({ where: { id: taskId, workspaceId } });
}

export async function listTasks(workspaceId: string, filter?: { agentId?: string; status?: string }) {
  return db.agentTask.findMany({
    where: {
      workspaceId,
      ...(filter?.agentId ? { agentId: filter.agentId } : {}),
      ...(filter?.status ? { status: parseTaskStatus(filter.status) } : {}),
    },
    orderBy: { createdAt: 'desc' },
  });
}

export async function updateTaskStatus(
  workspaceId: string,
  taskId: string,
  status: string,
  extra?: { output?: unknown; failureReason?: string },
) {
  const parsed = parseTaskStatus(status);
  const task = await db.agentTask.findFirst({ where: { id: taskId, workspaceId } });
  if (!task) throw new Error('Task not found in this workspace.');

  return db.agentTask.update({
    where: { id: taskId },
    data: {
      status: parsed,
      ...(extra?.output !== undefined ? { output: extra.output as Prisma.InputJsonValue } : {}),
      ...(extra?.failureReason !== undefined ? { failureReason: extra.failureReason } : {}),
      ...(parsed === TaskStatus.Failed ? { retries: { increment: 1 } } : {}),
    },
  });
}
