/**
 * AgentRuntime — the one place a task's `input` actually turns into tool
 * calls. Called by the worker (src/worker/index.ts), same as every other job
 * type; it does not run its own loop or its own queue.
 *
 * Flow: Agent -> AgentRuntime -> task -> inspect allowed tools -> execute
 * approved tool -> record result -> update task status -> record activity.
 *
 * Every enforcement point the brief asked for lives here, not in the tool,
 * not in a caller: permission (allowedTools), input/output shape (zod),
 * tool-call count, execution timeout, cooperative cancellation, and bounded,
 * idempotency-aware retry. A task never gets marked Completed unless its
 * tool calls actually ran and returned successfully.
 */
import { db } from '../db';
import { enqueue } from '../queue';
import { getTool } from './registry';
import { updateTaskStatus } from './tasks';
import { logActivity } from './activity';
import { TaskStatus } from '@/generated/prisma/enums';
import type { Prisma } from '@/generated/prisma/client';
import type { Agent, AgentTask } from '@/generated/prisma/client';
import './tools'; // registers every built-in tool as a side effect

/** Per-execution ceilings — configurable, never unbounded. Read lazily so tests can vary them per scenario. */
const maxToolCalls = () => Number(process.env.AGENT_MAX_TOOL_CALLS ?? 10);
const executionTimeoutMs = () => Number(process.env.AGENT_TASK_TIMEOUT_MS ?? 120_000);

type ToolCall = { tool: string; args: Record<string, unknown> };
type TaskWithAgent = AgentTask & { agent: Agent };

/** A failure that retrying can never fix — the request itself was malformed or disallowed. */
class NonRetryableError extends Error {}

/** Thrown internally to unwind the tool-call loop when the task was cancelled mid-run. */
class CancelledSignal extends Error {}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

function parseToolCalls(input: unknown): ToolCall[] {
  const raw = (input as { toolCalls?: unknown } | null)?.toolCalls;
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new NonRetryableError('Task input must include a non-empty toolCalls array.');
  }
  return raw.map((c, i) => {
    if (typeof c !== 'object' || c === null || typeof (c as { tool?: unknown }).tool !== 'string') {
      throw new NonRetryableError(`toolCalls[${i}] is malformed — expected { tool, args }.`);
    }
    const call = c as { tool: string; args?: unknown };
    return { tool: call.tool, args: (call.args ?? {}) as Record<string, unknown> };
  });
}

/** A task is only safe to retry from the top if every tool call in it is read-only or idempotent — otherwise a retry could redo a real side effect. */
function isTaskRetryable(toolCalls: ToolCall[]): boolean {
  return toolCalls.every((c) => {
    const tool = getTool(c.tool);
    return !!tool && (tool.readOnly || tool.idempotent);
  });
}

export async function executeAgentTask(workspaceId: string, taskId: string): Promise<void> {
  const task = await db.agentTask.findFirst({ where: { id: taskId, workspaceId }, include: { agent: true } });
  if (!task) throw new Error(`AgentTask ${taskId} not found in workspace ${workspaceId}.`);

  // Another worker tick, a cancellation, or a duplicate job already resolved this — idempotent no-op.
  if (task.status !== TaskStatus.Queued) return;

  if (task.agent.status !== 'active') {
    await terminalFail(task, `Agent "${task.agent.name}" is ${task.agent.status}, not active.`);
    return;
  }

  await updateTaskStatus(workspaceId, task.id, TaskStatus.Thinking);
  await logActivity(workspaceId, { agentId: task.agentId, taskId: task.id, type: 'task_started' });

  let toolCalls: ToolCall[];
  try {
    toolCalls = parseToolCalls(task.input);
  } catch (e) {
    await terminalFail(task, e instanceof Error ? e.message : String(e));
    return;
  }

  const limit = maxToolCalls();
  if (toolCalls.length > limit) {
    await terminalFail(task, `Task requested ${toolCalls.length} tool calls, over the limit of ${limit}.`);
    return;
  }

  const retryableOnFailure = isTaskRetryable(toolCalls);
  await updateTaskStatus(workspaceId, task.id, TaskStatus.Working);

  const outputs: unknown[] = [];
  try {
    await withTimeout(runToolCalls(task, toolCalls, outputs), executionTimeoutMs(), 'Task execution');
  } catch (e) {
    if (e instanceof CancelledSignal) {
      // cancelTask() already recorded task_cancelled when the cancellation was
      // requested — the runtime noticing it mid-loop isn't a second event.
      return; // status is already Cancelled — nothing to overwrite
    }
    const message = e instanceof Error ? e.message : String(e);
    if (e instanceof NonRetryableError) {
      await terminalFail(task, message);
    } else {
      await failWithRetry(task, message, retryableOnFailure);
    }
    return;
  }

  await updateTaskStatus(workspaceId, task.id, TaskStatus.Completed, { output: outputs });
  await logActivity(workspaceId, { agentId: task.agentId, taskId: task.id, type: 'task_completed' });
}

async function runToolCalls(task: TaskWithAgent, toolCalls: ToolCall[], outputs: unknown[]): Promise<void> {
  const allowedTools = new Set(Array.isArray(task.agent.allowedTools) ? (task.agent.allowedTools as unknown[]) : []);

  for (const call of toolCalls) {
    // Cooperative cancellation: re-read status before each call so a cancel
    // requested mid-run stops the sequence instead of racing to finish it.
    const fresh = await db.agentTask.findUnique({ where: { id: task.id }, select: { status: true } });
    if (fresh?.status === TaskStatus.Cancelled) throw new CancelledSignal();

    const tool = getTool(call.tool);
    if (!tool) throw new NonRetryableError(`Unknown tool: "${call.tool}".`);

    // The permission boundary: an agent may only call a tool whose required
    // permission is in ITS OWN allowedTools — checked here, unconditionally,
    // no matter what the caller (or a task crafted to name a disallowed tool
    // directly) asked for.
    if (!allowedTools.has(tool.requiredPermission)) {
      await logActivity(task.workspaceId, {
        agentId: task.agentId, taskId: task.id, type: 'tool_denied', meta: { tool: tool.name },
      });
      throw new NonRetryableError(`Agent "${task.agent.name}" is not permitted to use tool "${tool.name}".`);
    }

    const parsedInput = tool.inputSchema.safeParse(call.args);
    if (!parsedInput.success) {
      throw new NonRetryableError(`Invalid input for tool "${tool.name}": ${parsedInput.error.message}`);
    }

    await logActivity(task.workspaceId, { agentId: task.agentId, taskId: task.id, type: 'tool_called', meta: { tool: tool.name } });
    let result: unknown;
    try {
      result = await tool.handler(parsedInput.data, { workspaceId: task.workspaceId, agentId: task.agentId, taskId: task.id });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      await logActivity(task.workspaceId, {
        agentId: task.agentId, taskId: task.id, type: 'tool_failed', meta: { tool: tool.name, error: message },
      });
      throw new Error(`Tool "${tool.name}" failed: ${message}`);
    }

    const parsedOutput = tool.outputSchema.safeParse(result);
    if (!parsedOutput.success) {
      throw new NonRetryableError(`Tool "${tool.name}" returned a result that doesn't match its declared output schema.`);
    }
    outputs.push(parsedOutput.data);
    await logActivity(task.workspaceId, { agentId: task.agentId, taskId: task.id, type: 'tool_succeeded', meta: { tool: tool.name } });
  }
}

/** A failure retrying can never fix — no retry, straight to Failed. */
async function terminalFail(task: AgentTask, reason: string): Promise<void> {
  await db.agentTask.update({
    where: { id: task.id },
    data: { status: TaskStatus.Failed, failureReason: reason.slice(0, 2000), retries: { increment: 1 } },
  });
  await logActivity(task.workspaceId, {
    agentId: task.agentId, taskId: task.id, type: 'task_failed', meta: { reason: reason.slice(0, 500), retryable: false },
  });
}

/** A failure that MIGHT be transient — retry if the task is retry-safe and retries remain, otherwise Failed. */
async function failWithRetry(task: AgentTask, reason: string, retryable: boolean): Promise<void> {
  const nextRetries = task.retries + 1;
  const willRetry = retryable && nextRetries < task.maxRetries;

  await db.agentTask.update({
    where: { id: task.id },
    data: {
      status: willRetry ? TaskStatus.Queued : TaskStatus.Failed,
      retries: nextRetries,
      failureReason: reason.slice(0, 2000),
    },
  });

  await logActivity(task.workspaceId, {
    agentId: task.agentId, taskId: task.id,
    type: willRetry ? 'task_retried' : 'task_failed',
    meta: { reason: reason.slice(0, 500), retryable, attempt: nextRetries },
  });

  if (willRetry) {
    // Linear backoff, same shape as queue.ts's own failJob() — reusing the
    // existing Job queue for the retry itself rather than a second scheduler.
    const delayMs = 30_000 * nextRetries;
    await enqueue(task.workspaceId, 'run_agent_task', { taskId: task.id } as Prisma.InputJsonValue, new Date(Date.now() + delayMs));
  }
}
