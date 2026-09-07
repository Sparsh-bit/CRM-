/**
 * Command Center: turns one natural-language request into real AgentTasks
 * and lets them run through the exact existing pipeline — no second task
 * system, no second worker, no bypass of AgentRuntime.
 *
 * A "Command" is not a new database model. It's a root AgentTask (owned by
 * a per-workspace "Command Center" system agent that calls no tools itself)
 * whose children are the plan's steps — reusing AgentTask's existing
 * fields end to end: `description` holds the raw command text,
 * `input.plan` holds the resolved plan for the audit trail, `createdBy` is
 * the existing field, `output` holds the final CommandResult once every
 * step resolves. See docs/command-center.md for why this didn't need a
 * dedicated model.
 *
 * Dependency tracking deliberately does NOT reuse parentTaskId for the
 * dependency graph — every step's parentTaskId is the command's root (so
 * the existing MAX_TASK_DEPTH delegation-depth limit, designed for
 * agent-to-agent handoff chains, isn't consumed by a plan's own step count).
 * The real dependency edges live in `relatedRecordIds` (already documented
 * as "heterogeneous ids... not a single FK") — a step's relatedRecordIds is
 * the list of step task ids it must wait for. A step created with
 * dependencies is created with `enqueue: false`; onTaskResolved() (called
 * from AgentRuntime after every task settles) enqueues it once every id in
 * that list is Completed, or cancels it once any of them is Failed/Cancelled.
 */
import { db } from '../db';
import { createTask, cancelTask, enqueueTask, getTask } from './tasks';
import { logActivity } from './activity';
import { planCommand, type ResolvedPlan, type RejectedStep } from './planner';
import type { Prisma } from '@/generated/prisma/client';

const COMMAND_CENTER_ROLE = 'Command Center';
const TERMINAL_STATUSES = new Set(['Completed', 'Failed', 'Cancelled']);

/**
 * The Command Center's own bookkeeping agent — not a human-managed AI
 * employee, so this bypasses agents.ts's admin-gated createAgent() the same
 * way internal infrastructure (Job rows via enqueue()) bypasses a role
 * check: nothing here is a user-facing "create an agent" action. Lazily
 * provisioned once per workspace, calls no tools (allowedTools: []).
 */
async function ensureCommandCenterAgent(workspaceId: string) {
  const existing = await db.agent.findFirst({ where: { workspaceId, role: COMMAND_CENTER_ROLE } });
  if (existing) return existing;
  return db.agent.create({
    data: {
      workspaceId, name: 'Command Center', role: COMMAND_CENTER_ROLE, department: 'System',
      objective: 'Turns a natural-language request into real tasks for other agents. Calls no tools itself.',
      allowedTools: [] as unknown as Prisma.InputJsonValue, autonomyLevel: 'SuggestOnly', status: 'active',
    },
  });
}

export type CommandStatus = 'completed' | 'partial' | 'failed' | 'cancelled';

export type CommandResult = {
  status: CommandStatus;
  requested: string;
  goal?: string;
  agentsInvolved: { agentId: string; agentName: string; role: string }[];
  tasksTotal: number;
  tasksCompleted: number;
  tasksFailed: number;
  tasksCancelled: number;
  approvalsRequested: number;
  results: { taskId: string; agentName: string; agentRole: string; task: string; status: string; output: unknown; failureReason: string | null }[];
  rejectedSteps: RejectedStep[];
  unsupported?: string;
  recommendations: string[];
};

/** Section 7: a plan a future UI can show and let the user confirm — creates nothing. */
export async function previewCommand(workspaceId: string, commandText: string): Promise<ResolvedPlan> {
  return planCommand(workspaceId, commandText);
}

/** Plans AND executes — creates the real AgentTask tree and starts whatever has no unmet dependency. */
export async function executeCommand(workspaceId: string, createdBy: string | null, commandText: string) {
  const commandAgent = await ensureCommandCenterAgent(workspaceId);
  const root = await createTask(workspaceId, {
    agentId: commandAgent.id,
    title: commandText.slice(0, 120),
    description: commandText,
    input: { isCommandRoot: true, rawCommand: commandText },
    createdBy,
    enqueue: false, // the root never runs through AgentRuntime — it has no tool calls, only bookkeeping
  });

  let plan: ResolvedPlan;
  try {
    plan = await planCommand(workspaceId, commandText);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    await db.agentTask.update({ where: { id: root.id }, data: { status: 'Failed', failureReason: reason.slice(0, 2000) } });
    await logActivity(workspaceId, { agentId: commandAgent.id, taskId: root.id, type: 'task_failed', meta: { reason: reason.slice(0, 500) } });
    return getCommand(workspaceId, root.id);
  }

  await db.agentTask.update({
    where: { id: root.id },
    data: { input: { isCommandRoot: true, rawCommand: commandText, plan } as unknown as Prisma.InputJsonValue, status: 'Working' },
  });

  // Create every step first (so a later step's dependency ids are already
  // known), then enqueue only the ones with nothing left to wait for.
  const stepTaskIds: string[] = [];
  for (const step of plan.steps) {
    const dependencyTaskIds = step.dependencies.map((d) => stepTaskIds[d]).filter((id): id is string => !!id);
    const task = await createTask(workspaceId, {
      agentId: step.agentId,
      parentTaskId: root.id, // every step's parent is the command root — see the file comment on why this isn't the dependency graph
      title: step.task.slice(0, 120),
      description: step.task,
      input: { toolCalls: step.toolCalls, commandRootTaskId: root.id },
      relatedRecordIds: dependencyTaskIds, // the actual dependency edges
      createdBy,
      enqueue: dependencyTaskIds.length === 0,
    });
    stepTaskIds[step.index] = task.id;
  }

  await logActivity(workspaceId, {
    agentId: commandAgent.id, taskId: root.id, type: 'task_started',
    meta: { steps: plan.steps.length, rejected: plan.rejectedSteps.length },
  });

  // Zero executable steps (everything rejected/unsupported) — nothing will
  // ever call back in, so finalize right away instead of leaving it hanging.
  await finalizeCommandIfDone(workspaceId, root.id);

  return getCommand(workspaceId, root.id);
}

/**
 * Called by AgentRuntime (src/lib/agents/runtime.ts) after a task reaches a
 * genuinely terminal state (Completed/Failed/Cancelled — never when it goes
 * back to Queued for its own retry, since nothing downstream should react
 * until the retry itself actually resolves). A no-op for the overwhelming
 * majority of tasks, which were never part of a command
 * (input.commandRootTaskId unset). For the ones that were:
 * cascades cancellation to anything downstream of a Failed/Cancelled
 * dependency, enqueues anything whose dependencies just all completed, and
 * finalizes the command once every step has settled.
 */
export async function onTaskResolved(workspaceId: string, taskId: string): Promise<void> {
  const task = await db.agentTask.findUnique({ where: { id: taskId }, select: { input: true } });
  const rootTaskId = (task?.input as { commandRootTaskId?: string } | null)?.commandRootTaskId;
  if (!rootTaskId) return;

  // Small, bounded fixed point (a plan has at most COMMAND_MAX_TASKS steps) —
  // simplicity over a real graph-traversal algorithm for a handful of nodes.
  for (let pass = 0; pass < 20; pass++) {
    const siblings = await db.agentTask.findMany({ where: { workspaceId, input: { path: ['commandRootTaskId'], equals: rootTaskId } } });
    const statusById = new Map(siblings.map((s) => [s.id, s.status as string]));
    let changed = false;

    for (const s of siblings) {
      if (TERMINAL_STATUSES.has(s.status)) continue;
      const deps = Array.isArray(s.relatedRecordIds) ? (s.relatedRecordIds as unknown[]).filter((d): d is string => typeof d === 'string') : [];
      if (deps.length === 0) continue; // no dependency — it was enqueued at creation, nothing for this hook to do

      const depStatuses = deps.map((d) => statusById.get(d));
      if (depStatuses.some((st) => st === 'Failed' || st === 'Cancelled')) {
        try { await cancelTask(workspaceId, s.id); changed = true; }
        catch { /* raced to a terminal state already — never falsely claim we stopped it */ }
      } else if (s.status === 'Queued' && depStatuses.length === deps.length && depStatuses.every((st) => st === 'Completed')) {
        await enqueueTask(workspaceId, s.id); // its own status stays Queued until the worker actually runs it
      }
    }
    if (!changed) break;
  }

  await finalizeCommandIfDone(workspaceId, rootTaskId);
}

async function finalizeCommandIfDone(workspaceId: string, rootTaskId: string): Promise<void> {
  const root = await db.agentTask.findUnique({ where: { id: rootTaskId } });
  if (!root || root.status !== 'Working') return; // not started yet, or already finalized/cancelled

  const steps = await db.agentTask.findMany({ where: { workspaceId, input: { path: ['commandRootTaskId'], equals: rootTaskId } } });
  if (steps.length > 0 && !steps.every((s) => TERMINAL_STATUSES.has(s.status))) return; // still work in flight

  const result = await buildCommandResult(workspaceId, root, steps);
  await db.agentTask.update({
    where: { id: rootTaskId },
    data: { status: result.status === 'failed' ? 'Failed' : 'Completed', output: result as unknown as Prisma.InputJsonValue },
  });
  await logActivity(workspaceId, {
    agentId: root.agentId, taskId: root.id,
    type: result.status === 'failed' ? 'task_failed' : 'task_completed',
    meta: { commandStatus: result.status, tasksCompleted: result.tasksCompleted, tasksFailed: result.tasksFailed },
  });
}

async function buildCommandResult(
  workspaceId: string,
  root: { input: unknown; description: string | null },
  steps: { id: string; agentId: string; description: string | null; status: string; output: unknown; failureReason: string | null }[],
): Promise<CommandResult> {
  const meta = root.input as { rawCommand?: string; plan?: ResolvedPlan } | null;
  const plan = meta?.plan;

  const tasksCompleted = steps.filter((s) => s.status === 'Completed').length;
  const tasksFailed = steps.filter((s) => s.status === 'Failed').length;
  const tasksCancelled = steps.filter((s) => s.status === 'Cancelled').length;

  const agentIds = [...new Set(steps.map((s) => s.agentId))];
  const agents = agentIds.length ? await db.agent.findMany({ where: { id: { in: agentIds } }, select: { id: true, name: true, role: true } }) : [];
  const agentById = new Map(agents.map((a) => [a.id, a]));

  const approvalsRequested = steps.length
    ? await db.approval.count({ where: { workspaceId, taskId: { in: steps.map((s) => s.id) } } })
    : 0;

  const status: CommandStatus =
    steps.length === 0 ? 'failed' :
    tasksCancelled === steps.length ? 'cancelled' :
    tasksCompleted === steps.length ? 'completed' :
    tasksCompleted === 0 ? 'failed' : 'partial';

  const recommendations: string[] = [];
  if (plan?.unsupported) recommendations.push(plan.unsupported);
  if (plan?.rejectedSteps.length) {
    recommendations.push(`${plan.rejectedSteps.length} planned step(s) could not be scheduled: ${plan.rejectedSteps.map((r) => r.reason).join('; ')}`);
  }
  if (tasksFailed > 0) recommendations.push(`${tasksFailed} task(s) failed — see each result's failureReason.`);
  if (approvalsRequested > 0) recommendations.push(`${approvalsRequested} action(s) are waiting for approval before anything is sent.`);

  return {
    status,
    requested: meta?.rawCommand ?? root.description ?? '',
    goal: plan?.goal,
    agentsInvolved: agentIds.map((id) => ({ agentId: id, agentName: agentById.get(id)?.name ?? 'unknown', role: agentById.get(id)?.role ?? 'unknown' })),
    tasksTotal: steps.length, tasksCompleted, tasksFailed, tasksCancelled,
    approvalsRequested,
    results: steps.map((s) => ({
      taskId: s.id, agentName: agentById.get(s.agentId)?.name ?? 'unknown', agentRole: agentById.get(s.agentId)?.role ?? 'unknown',
      task: s.description ?? '', status: s.status, output: s.output, failureReason: s.failureReason,
    })),
    rejectedSteps: plan?.rejectedSteps ?? [],
    unsupported: plan?.unsupported,
    recommendations,
  };
}

/** Cancels every non-terminal step plus the root itself — reuses cancelTask()'s own terminal-state guard, never falsely reports stopping something already done. */
export async function cancelCommand(workspaceId: string, rootTaskId: string) {
  const root = await getTask(workspaceId, rootTaskId);
  if (!root) throw new Error('Command not found in this workspace.');

  const steps = await db.agentTask.findMany({ where: { workspaceId, input: { path: ['commandRootTaskId'], equals: rootTaskId } } });
  for (const s of steps) {
    try { await cancelTask(workspaceId, s.id); } catch { /* already terminal */ }
  }
  try { await cancelTask(workspaceId, root.id); } catch { /* already terminal */ }

  return getCommand(workspaceId, rootTaskId);
}

export async function listCommands(workspaceId: string) {
  return db.agentTask.findMany({
    where: { workspaceId, input: { path: ['isCommandRoot'], equals: true } },
    orderBy: { createdAt: 'desc' },
  });
}

export async function getCommand(workspaceId: string, rootTaskId: string) {
  const root = await getTask(workspaceId, rootTaskId);
  if (!root) return null;
  const steps = await db.agentTask.findMany({
    where: { workspaceId, input: { path: ['commandRootTaskId'], equals: rootTaskId } },
    orderBy: { createdAt: 'asc' },
  });
  return { root, steps };
}
