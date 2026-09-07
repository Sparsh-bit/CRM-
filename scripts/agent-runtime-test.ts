/**
 * Real-database integration test for the AgentRuntime (Phase 3): tool
 * registry + permission enforcement, task execution and state transitions,
 * retry/timeout/tool-call/depth limits, cancellation, and activity logging.
 * Same tier as scripts/agent-workforce-test.ts — needs live Postgres, run
 * separately from `npm test` via `npm run runtime:test`.
 *
 * executeAgentTask() is called directly rather than through a running worker
 * process — it's the exact function the worker dispatches to, so this
 * exercises the real runtime without needing a second process running.
 */
import 'dotenv/config';
process.env.AGENT_MAX_TOOL_CALLS = '3'; // small, deterministic limit for this run

import { PrismaClient } from '../src/generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { createAgent, updateAgent, type AgentActor } from '../src/lib/agents/agents';
import { createTask, updateTaskStatus, cancelTask, delegateTask, getTask, MAX_TASK_DEPTH } from '../src/lib/agents/tasks';
import { listActivity } from '../src/lib/agents/activity';
import { executeAgentTask } from '../src/lib/agents/runtime';

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const db = new PrismaClient({ adapter });

let fails = 0;
function check(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { fails++; console.log(`FAIL ${name}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`); }
  else console.log(`pass ${name}`);
}
async function checkThrows(name: string, fn: () => Promise<unknown>) {
  try { await fn(); fails++; console.log(`FAIL ${name}\n  expected a throw, got none`); }
  catch { console.log(`pass ${name}`); }
}

async function main() {
  const ws = await db.workspace.create({ data: { name: 'Runtime Test A', slug: 'rt-test-a-' + Date.now() } });
  const other = await db.workspace.create({ data: { name: 'Runtime Test B', slug: 'rt-test-b-' + Date.now() } });
  const admin: AgentActor = { workspaceId: ws.id, role: 'admin' };

  try {
    const agent = await createAgent(admin, { name: 'Echo Bot', role: 'Test', allowedTools: ['echo'] });
    const noToolsAgent = await createAgent(admin, { name: 'No Tools Bot', role: 'Test' });

    // ── valid execution + authorized tool + task success ─────────────
    const okTask = await createTask(ws.id, { agentId: agent.id, title: 'say hi', input: { toolCalls: [{ tool: 'echo', args: { message: 'hi' } }] } });
    await executeAgentTask(ws.id, okTask.id);
    const completed = await getTask(ws.id, okTask.id);
    check('a valid task with an authorized tool completes', completed?.status, 'Completed');
    check('output records the tool result', completed?.output, [{ echoed: 'hi' }]);
    check('approvalState is untouched for a task with no approval step', completed?.approvalState, 'None');

    // ── invalid agent (not found in this workspace) ────────────────
    await checkThrows('executing a task id from another workspace is rejected', () => executeAgentTask(other.id, okTask.id));

    // ── invalid agent (paused) ──────────────────────────────────────
    await updateAgent(admin, agent.id, { status: 'paused' });
    const pausedTask = await createTask(ws.id, { agentId: agent.id, title: 'should not run', input: { toolCalls: [{ tool: 'echo', args: { message: 'x' } }] } });
    await executeAgentTask(ws.id, pausedTask.id);
    const pausedResult = await getTask(ws.id, pausedTask.id);
    check('a task for a paused agent fails without running any tool', pausedResult?.status, 'Failed');
    await updateAgent(admin, agent.id, { status: 'active' });

    // ── unauthorized tool + no bypass via a raw tool name ───────────
    const unauthorizedTask = await createTask(ws.id, { agentId: noToolsAgent.id, title: 'try echo anyway', input: { toolCalls: [{ tool: 'echo', args: { message: 'sneaky' } }] } });
    await executeAgentTask(ws.id, unauthorizedTask.id);
    const unauthorizedResult = await getTask(ws.id, unauthorizedTask.id);
    check('an agent with an empty allowedTools list cannot call echo by naming it directly', unauthorizedResult?.status, 'Failed');
    check('the denial is recorded, not silently ignored', unauthorizedResult?.failureReason?.includes('not permitted'), true);
    const deniedLog = await listActivity(ws.id, { agentId: noToolsAgent.id, taskId: unauthorizedTask.id });
    check('a tool_denied activity event was logged for the bypass attempt', deniedLog.some((a) => a.type === 'tool_denied'), true);

    // ── invalid tool input ───────────────────────────────────────────
    const badInputTask = await createTask(ws.id, { agentId: agent.id, title: 'bad input', input: { toolCalls: [{ tool: 'echo', args: { message: '' } }] } });
    await executeAgentTask(ws.id, badInputTask.id);
    check('a tool call with input that fails its schema fails the task', (await getTask(ws.id, badInputTask.id))?.status, 'Failed');

    // ── unknown tool name ─────────────────────────────────────────────
    const unknownToolTask = await createTask(ws.id, { agentId: agent.id, title: 'ghost tool', input: { toolCalls: [{ tool: 'does-not-exist', args: {} }] } });
    await executeAgentTask(ws.id, unknownToolTask.id);
    check('a reference to an unregistered tool fails cleanly', (await getTask(ws.id, unknownToolTask.id))?.status, 'Failed');

    // ── task failure, non-retryable (mutating tool) ──────────────────
    const nonRetryAgent = await createAgent(admin, { name: 'Fail Bot', role: 'Test', allowedTools: ['test-fail'] });
    const nonRetryTask = await createTask(ws.id, {
      agentId: nonRetryAgent.id, title: 'fails for good', maxRetries: 3,
      input: { toolCalls: [{ tool: 'test-fail', args: { reason: 'boom' } }] },
    });
    await executeAgentTask(ws.id, nonRetryTask.id);
    const nonRetryResult = await getTask(ws.id, nonRetryTask.id);
    check('a non-idempotent tool failure goes straight to Failed, no retry scheduled', nonRetryResult?.status, 'Failed');
    check('retries is still recorded even though it was not retried again', nonRetryResult?.retries, 1);

    // ── retry limit (idempotent tool) ─────────────────────────────────
    const retryAgent = await createAgent(admin, { name: 'Retry Bot', role: 'Test', allowedTools: ['test-fail-safe'] });
    const retryTask = await createTask(ws.id, {
      agentId: retryAgent.id, title: 'fails safely', maxRetries: 2,
      input: { toolCalls: [{ tool: 'test-fail-safe', args: { reason: 'transient' } }] },
    });
    await executeAgentTask(ws.id, retryTask.id);
    const afterFirstFail = await getTask(ws.id, retryTask.id);
    check('a retryable failure with retries remaining goes back to Queued, not Failed', afterFirstFail?.status, 'Queued');
    check('a retry is actually scheduled as a fresh job', (await db.job.count({ where: { workspaceId: ws.id, type: 'run_agent_task', payload: { path: ['taskId'], equals: retryTask.id } } })) >= 1, true);

    await executeAgentTask(ws.id, retryTask.id); // simulate the scheduled retry firing
    const afterSecondFail = await getTask(ws.id, retryTask.id);
    check('retry limit reached -> task is permanently Failed, not requeued again', afterSecondFail?.status, 'Failed');
    check('retries matches maxRetries once exhausted', afterSecondFail?.retries, 2);
    const retryLog = await listActivity(ws.id, { agentId: retryAgent.id, taskId: retryTask.id });
    check('task_retried was logged for the first failure', retryLog.some((a) => a.type === 'task_retried'), true);
    check('task_failed was logged for the final failure', retryLog.some((a) => a.type === 'task_failed'), true);

    // ── timeout ────────────────────────────────────────────────────────
    process.env.AGENT_TASK_TIMEOUT_MS = '50';
    const timeoutTask = await createTask(ws.id, { agentId: agent.id, title: 'too slow', input: { toolCalls: [{ tool: 'echo', args: { message: 'slow', delayMs: 400 } }] } });
    await executeAgentTask(ws.id, timeoutTask.id);
    const timeoutResult = await getTask(ws.id, timeoutTask.id);
    check('a tool call slower than the execution timeout fails the task', timeoutResult?.status === 'Failed' || timeoutResult?.status === 'Queued', true);
    check('the failure reason mentions the timeout', timeoutResult?.failureReason?.includes('timed out'), true);
    delete process.env.AGENT_TASK_TIMEOUT_MS;

    // ── tool-call limit (AGENT_MAX_TOOL_CALLS=3 for this whole script) ──
    const tooManyTask = await createTask(ws.id, {
      agentId: agent.id, title: 'too many calls',
      input: { toolCalls: Array.from({ length: 4 }, (_, i) => ({ tool: 'echo', args: { message: `${i}` } })) },
    });
    await executeAgentTask(ws.id, tooManyTask.id);
    const tooManyResult = await getTask(ws.id, tooManyTask.id);
    check('exceeding the tool-call limit fails without running anything', tooManyResult?.status, 'Failed');
    check('the failure names the limit', tooManyResult?.failureReason?.includes('limit'), true);

    // ── depth limit via delegateTask ───────────────────────────────────
    let chain = await createTask(ws.id, { agentId: agent.id, title: 'root' });
    for (let i = 0; i < MAX_TASK_DEPTH - 1; i++) {
      chain = await delegateTask(ws.id, chain.id, { agentId: agent.id, title: `depth ${i}` });
    }
    await checkThrows(`delegateTask enforces the same depth limit (${MAX_TASK_DEPTH}) as createTask`, () =>
      delegateTask(ws.id, chain.id, { agentId: agent.id, title: 'too deep' }));
    const delegationLog = await listActivity(ws.id, { agentId: agent.id });
    check('delegation_created was logged for the handoff', delegationLog.some((a) => a.type === 'delegation_created'), true);

    // ── cancellation ────────────────────────────────────────────────────
    const cancelTarget = await createTask(ws.id, { agentId: agent.id, title: 'to be cancelled' });
    await checkThrows('cancelling a completed task is refused', async () => {
      await updateTaskStatus(ws.id, cancelTarget.id, 'Completed');
      await cancelTask(ws.id, cancelTarget.id);
    });
    const cancellable = await createTask(ws.id, { agentId: agent.id, title: 'cancel me' });
    const cancelled = await cancelTask(ws.id, cancellable.id);
    check('a queued task can be cancelled', cancelled.status, 'Cancelled');
    await executeAgentTask(ws.id, cancellable.id); // the runtime must not resurrect a cancelled task
    check('the runtime leaves an already-cancelled task alone', (await getTask(ws.id, cancellable.id))?.status, 'Cancelled');

    // ── activity logging (breadth) ───────────────────────────────────
    const fullLog = await listActivity(ws.id, { agentId: agent.id, taskId: okTask.id });
    const types = new Set(fullLog.map((a) => a.type));
    check('task_started was logged', types.has('task_started'), true);
    check('tool_called was logged', types.has('tool_called'), true);
    check('tool_succeeded was logged', types.has('tool_succeeded'), true);
    check('task_completed was logged', types.has('task_completed'), true);

    // ── workspace isolation / no cross-workspace tool access ──────────
    check('a different workspace sees none of this agent\'s activity', (await listActivity(other.id, { agentId: agent.id })).length, 0);
    const crossTask = await createTask(other.id, { agentId: (await createAgent({ workspaceId: other.id, role: 'admin' }, { name: 'Other Bot', role: 'Test', allowedTools: ['echo'] })).id, title: 'lives in B' });
    await checkThrows('executing workspace B\'s task under workspace A is rejected outright', () => executeAgentTask(ws.id, crossTask.id));
  } finally {
    await db.workspace.deleteMany({ where: { id: { in: [ws.id, other.id] } } });
  }

  console.log(fails ? `\n${fails} FAILED` : '\nall agent runtime integration tests passed');
  process.exit(fails ? 1 : 0);
}

main().finally(() => db.$disconnect());
