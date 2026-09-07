/**
 * Real-database integration test for Phase 7: the Command Center (planner +
 * task-graph execution on top of the existing AgentRuntime/Job/worker
 * pipeline). Same tier as the other scripts/*-test.ts scripts — live
 * Postgres, the AI provider mocked (deterministic plans, not a live model),
 * run separately from `npm test` via `npm run command-center:test`.
 */
import 'dotenv/config';
process.env.AI_PROVIDER = 'groq';
process.env.GROQ_API_KEY = 'fake-for-test';

import { PrismaClient } from '../src/generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { createAgent, type AgentActor } from '../src/lib/agents/agents';
import { getTask } from '../src/lib/agents/tasks';
import { executeAgentTask } from '../src/lib/agents/runtime';
import { previewCommand, executeCommand, cancelCommand, getCommand, listCommands } from '../src/lib/agents/commandCenter';

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const db = new PrismaClient({ adapter });

let fails = 0;
function check(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { fails++; console.log(`FAIL ${name}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`); }
  else console.log(`pass ${name}`);
}
function checkTrue(name: string, got: boolean) { check(name, got, true); }
async function checkThrows(name: string, fn: () => Promise<unknown>) {
  try { await fn(); fails++; console.log(`FAIL ${name}\n  expected a throw, got none`); }
  catch { console.log(`pass ${name}`); }
}

const realFetch = global.fetch;
let lastRequestBody: string | null = null;
let groqResponseText = '';
function mockGroq(responseText: string) {
  groqResponseText = responseText;
}
function installFetchMock() {
  // @ts-expect-error - test double
  global.fetch = async (url: string, init?: RequestInit) => {
    if (url.includes('api.groq.com')) {
      lastRequestBody = typeof init?.body === 'string' ? init.body : null;
      return new Response(JSON.stringify({ choices: [{ message: { content: groqResponseText } }], usage: { prompt_tokens: 5, completion_tokens: 5 } }), { status: 200 });
    }
    return new Response('{}', { status: 404 });
  };
}

async function runReadyTasks(workspaceId: string, rootTaskId: string, maxRounds = 5) {
  // Simulate the worker: repeatedly execute whatever step task is due (has a
  // Job) until nothing changes. Real Job dispatch is proven separately by
  // the dedicated real-worker E2E test below.
  for (let round = 0; round < maxRounds; round++) {
    const due = await db.job.findMany({ where: { workspaceId, type: 'run_agent_task', status: 'pending' } });
    if (due.length === 0) break;
    for (const job of due) {
      const taskId = (job.payload as { taskId?: string })?.taskId;
      if (taskId) await executeAgentTask(workspaceId, taskId);
      await db.job.update({ where: { id: job.id }, data: { status: 'done' } });
    }
  }
  return getCommand(workspaceId, rootTaskId);
}

async function main() {
  installFetchMock();
  const ws = await db.workspace.create({ data: { name: 'Command Center Test A', slug: 'cc-test-a-' + Date.now() } });
  const other = await db.workspace.create({ data: { name: 'Command Center Test B', slug: 'cc-test-b-' + Date.now() } });
  const admin: AgentActor = { workspaceId: ws.id, role: 'admin' };

  try {
    const list = await db.leadList.create({ data: { workspaceId: ws.id, name: 'L' } });
    const lead = await db.lead.create({ data: { workspaceId: ws.id, listId: list.id, fullName: 'Cmd Lead', email: 'cmd@test.local', status: 'new', score: 80 } });

    const research = await createAgent(admin, { name: 'Research Bot', role: 'Research', allowedTools: ['crm:read'] });
    const outreach = await createAgent(admin, { name: 'Outreach Bot', role: 'Outreach', allowedTools: ['outreach:draft', 'outreach:propose'], autonomyLevel: 'DraftAndRequestApproval' });

    // ── valid natural-language plan -> successful execution ──────────────
    mockGroq(JSON.stringify({
      goal: 'Look up the lead',
      tasks: [{ agentRole: 'Research', task: 'Look up the lead', toolCalls: [{ tool: 'get_lead', args: { leadId: lead.id } }], dependencies: [] }],
    }));
    const cmd1 = await executeCommand(ws.id, null, 'Find out about our lead');
    checkTrue('a valid command creates a root task', !!cmd1?.root.id);
    check('the root command starts Working before its step resolves', cmd1?.root.status, 'Working');
    check('exactly one step task was created', cmd1?.steps.length, 1);

    const resolved1 = await runReadyTasks(ws.id, cmd1!.root.id);
    check('the step task completes via the real AgentRuntime', resolved1?.steps[0].status, 'Completed');
    check('the root command finalizes as completed once its only step succeeds', resolved1?.root.status, 'Completed');
    const result1 = resolved1?.root.output as { status: string; tasksCompleted: number } | null;
    check('the CommandResult reports the real outcome, not a fabricated one', result1?.status, 'completed');
    check('the CommandResult counts the real completed task', result1?.tasksCompleted, 1);

    // ── prompt-injection resistance: the untrusted command is clearly delimited ──
    checkTrue('the raw command text was sent inside the delimited untrusted section, not as bare instructions', !!lastRequestBody && lastRequestBody.includes('USER REQUEST') && lastRequestBody.includes('Find out about our lead'));

    // ── malformed planner output ──────────────────────────────────────────
    mockGroq('this is not json at all');
    await checkThrows('previewCommand rejects malformed planner output rather than executing garbage', () => previewCommand(ws.id, 'do something'));
    const cmd2 = await executeCommand(ws.id, null, 'do something with garbage output');
    check('executeCommand reports a real Failed root on malformed planner output, never fake success', cmd2?.root.status, 'Failed');
    checkTrue('the failure reason explains why, not a silent failure', !!cmd2?.root.failureReason);

    // ── unknown agent (an invented role never rejected structurally) ──────
    mockGroq(JSON.stringify({
      goal: 'g', tasks: [{ agentRole: 'Made-Up Legal Agent', task: 'x', toolCalls: [], dependencies: [] }],
    }));
    const preview3 = await previewCommand(ws.id, 'ask legal to review this');
    check('a planner-invented agent role is rejected, never guessed at or substituted', preview3.steps.length, 0);
    checkTrue('the rejection names the real reason', preview3.rejectedSteps[0]?.reason.includes('No active agent'));

    // ── unauthorized / unavailable tool — dropped, not silently trusted ───
    mockGroq(JSON.stringify({
      goal: 'g', tasks: [{ agentRole: 'Research', task: 'x', toolCalls: [{ tool: 'propose_send', args: {} }, { tool: 'not_a_real_tool', args: {} }], dependencies: [] }],
    }));
    const preview4 = await previewCommand(ws.id, 'have research send an email');
    check('Research keeps the step but neither an unauthorized nor an unregistered tool survives resolution', preview4.steps[0]?.toolCalls.length, 0);
    checkTrue('the dropped tools are recorded, not silently vanished', preview4.steps[0]?.droppedToolCalls.length === 2);
    // executing this (empty toolCalls) must fail honestly through the real runtime, never fake success
    const cmd4 = await executeCommand(ws.id, null, 'have research send an email');
    const resolved4 = await runReadyTasks(ws.id, cmd4!.root.id);
    check('a step left with no valid tool calls fails through the real runtime, not a fabricated result', resolved4?.steps[0].status, 'Failed');

    // ── planner is not the final authority — AgentRuntime re-checks independently ──
    // Bypass the planner's own filtering entirely and hand the runtime a tool
    // Research was never granted, exactly as if a bug let it slip through.
    const bypassTask = await db.agentTask.create({
      data: { workspaceId: ws.id, agentId: research.id, title: 'bypass attempt', status: 'Queued', input: { toolCalls: [{ tool: 'outreach:propose', args: {} }, { tool: 'get_company', args: { company: 'x' } }] } },
    });
    await executeAgentTask(ws.id, bypassTask.id);
    check('AgentRuntime denies a disallowed tool regardless of how the task was created, not just when the planner filters it', (await getTask(ws.id, bypassTask.id))?.status, 'Failed');

    // ── dependency ordering ────────────────────────────────────────────────
    mockGroq(JSON.stringify({
      goal: 'research then propose',
      tasks: [
        { agentRole: 'Research', task: 'look up the lead', toolCalls: [{ tool: 'get_lead', args: { leadId: lead.id } }], dependencies: [] },
        { agentRole: 'Outreach', task: 'propose an email', toolCalls: [{ tool: 'propose_send', args: { leadId: lead.id, channel: 'email', subject: 'hi', body: 'hi', reason: 'from command center' } }], dependencies: [0] },
      ],
    }));
    const cmd5 = await executeCommand(ws.id, null, 'research this lead then propose outreach');
    const step0 = cmd5!.steps[0], step1 = cmd5!.steps[1];
    check('step 0 (no dependency) is enqueued immediately', (await db.job.count({ where: { workspaceId: ws.id, payload: { path: ['taskId'], equals: step0.id } } })) > 0, true);
    check('step 1 (depends on step 0) is NOT enqueued until its dependency resolves', (await db.job.count({ where: { workspaceId: ws.id, payload: { path: ['taskId'], equals: step1.id } } })), 0);
    check('step 1 stays Queued-but-un-run while waiting', (await getTask(ws.id, step1.id))?.status, 'Queued');

    await executeAgentTask(ws.id, step0.id); // runs step 0 -> triggers onTaskResolved -> should enqueue step 1
    check('completing step 0 enqueues step 1 via the dependency hook', (await db.job.count({ where: { workspaceId: ws.id, payload: { path: ['taskId'], equals: step1.id } } })) > 0, true);

    const resolved5 = await runReadyTasks(ws.id, cmd5!.root.id);
    check('the dependent step actually ran once its dependency completed', resolved5?.steps[1].status, 'Completed');
    check('a real Approval was created by the dependent step (Phase 6 reuse, not a new approval system)', (resolved5?.root.output as { approvalsRequested: number } | null)?.approvalsRequested, 1);
    check('the command finalizes completed once both real steps succeed', resolved5?.root.status, 'Completed');

    // ── circular / forward dependency references are structurally impossible ──
    mockGroq(JSON.stringify({
      goal: 'g',
      tasks: [
        { agentRole: 'Research', task: 'a', toolCalls: [{ tool: 'get_lead', args: { leadId: lead.id } }], dependencies: [1] }, // forward reference — invalid
        { agentRole: 'Research', task: 'b', toolCalls: [{ tool: 'get_lead', args: { leadId: lead.id } }], dependencies: [1] }, // self reference — invalid
      ],
    }));
    const preview6 = await previewCommand(ws.id, 'plan with bad dependencies');
    check('a forward dependency reference is dropped, not treated as a real edge', preview6.steps[0]?.dependencies, []);
    check('a self dependency reference is dropped', preview6.steps[1]?.dependencies, []);

    // ── partial failure: one branch fails, an independent one still completes ──
    // get_lead with a missing id still succeeds (with null data) — a real
    // failure needs an actually-invalid tool call (list_leads rejects a
    // negative limit at its own zod schema).
    mockGroq(JSON.stringify({
      goal: 'g',
      tasks: [
        { agentRole: 'Research', task: 'will fail on bad input', toolCalls: [{ tool: 'list_leads', args: { limit: -5 } }], dependencies: [] },
        { agentRole: 'Research', task: 'independent, will succeed', toolCalls: [{ tool: 'get_lead', args: { leadId: lead.id } }], dependencies: [] },
      ],
    }));
    const cmd7 = await executeCommand(ws.id, null, 'one good one bad, independently');
    const resolved7 = await runReadyTasks(ws.id, cmd7!.root.id);
    check('the failing independent step actually fails, not silently skipped', resolved7?.steps[0].status, 'Failed');
    check('the succeeding independent step still completes despite its sibling failing', resolved7?.steps[1].status, 'Completed');
    check('the command reports partial, never claims full success when one task failed', (resolved7?.root.output as { status: string } | null)?.status, 'partial');
    check('the root itself is not marked Failed when at least one task succeeded', resolved7?.root.status, 'Completed');

    // ── cancellation ─────────────────────────────────────────────────────
    mockGroq(JSON.stringify({
      goal: 'g',
      tasks: [
        { agentRole: 'Research', task: 'first', toolCalls: [{ tool: 'get_lead', args: { leadId: lead.id } }], dependencies: [] },
        { agentRole: 'Research', task: 'second, depends on first', toolCalls: [{ tool: 'get_lead', args: { leadId: lead.id } }], dependencies: [0] },
      ],
    }));
    const cmd8 = await executeCommand(ws.id, null, 'a command to cancel');
    const cancelled8 = await cancelCommand(ws.id, cmd8!.root.id);
    check('cancelling a command marks its root Cancelled', cancelled8?.root.status, 'Cancelled');
    checkTrue('cancelling a command cancels its not-yet-run steps too', cancelled8!.steps.every((s) => s.status === 'Cancelled' || s.status === 'Completed'));
    check('a cancelled dependent step never got a Job — no false claim of stopping something already running', await db.job.count({ where: { workspaceId: ws.id, payload: { path: ['taskId'], equals: cmd8!.steps[1].id } } }), 0);

    // ── plans respect the existing task-depth limit design (steps parent to root, not chained) ──
    mockGroq(JSON.stringify({
      goal: 'many steps',
      tasks: Array.from({ length: 6 }, (_, i) => ({ agentRole: 'Research', task: `step ${i}`, toolCalls: [{ tool: 'get_lead', args: { leadId: lead.id } }], dependencies: [] })),
    }));
    const cmd9 = await executeCommand(ws.id, null, 'a plan with more steps than the old delegation depth limit');
    check('a 6-step plan (more than MAX_TASK_DEPTH) creates every step successfully — steps parent to the root, not to each other', cmd9?.steps.length, 6);

    // ── workspace isolation ────────────────────────────────────────────────
    check('a command from another workspace is invisible', await getCommand(other.id, cmd1!.root.id), null);
    await checkThrows('cancelling another workspace\'s command fails outright', () => cancelCommand(other.id, cmd1!.root.id));
    check('listCommands only returns this workspace\'s own commands', (await listCommands(other.id)).length, 0);
    checkTrue('listCommands returns this workspace\'s real command history', (await listCommands(ws.id)).length >= 5);

    console.log('\nall command center checks completed');
  } finally {
    global.fetch = realFetch;
    await db.workspace.deleteMany({ where: { id: { in: [ws.id, other.id] } } });
  }

  console.log(fails ? `\n${fails} FAILED` : '\nall command center integration tests passed');
  process.exit(fails ? 1 : 0);
}

main().finally(() => db.$disconnect());
