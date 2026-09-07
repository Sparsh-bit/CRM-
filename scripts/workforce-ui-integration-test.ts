/**
 * Phase 8 integration test: the exact backend contracts the existing
 * Workforce UI (owned by the frontend session — src/app/workforce/*) either
 * already calls, or is ready to call once its own UI-freeze lifts. This
 * does not render or drive any page — it replicates each page's own query/
 * call shape directly against the real service layer and real Postgres, so
 * a regression here is caught regardless of which session next touches the
 * page that depends on it. Run separately from `npm test` via
 * `npm run workforce-ui:test`.
 */
import 'dotenv/config';
process.env.AI_PROVIDER = 'groq';
process.env.GROQ_API_KEY = 'fake-for-test';

import { PrismaClient } from '../src/generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { TaskStatus, ApprovalState } from '@/generated/prisma/enums';
import { createAgent, getAgent, type AgentActor } from '../src/lib/agents/agents';
import { listTasks } from '../src/lib/agents/tasks';
import { listApprovals, decideApproval } from '../src/lib/agents/approvals';
import { listActivity } from '../src/lib/agents/activity';
import { decideOutreachApproval, proposeOutreach } from '../src/lib/agents/outreach';
import { previewCommand, executeCommand, type CommandResult } from '../src/lib/agents/commandCenter';
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

const realFetch = global.fetch;
function mockGroq(planJson: string) {
  // @ts-expect-error - test double
  global.fetch = async (url: string) => {
    if (url.includes('api.groq.com')) {
      return new Response(JSON.stringify({ choices: [{ message: { content: planJson } }], usage: { prompt_tokens: 5, completion_tokens: 5 } }), { status: 200 });
    }
    return new Response('{}', { status: 404 });
  };
}

const ACTIVE_STATUSES = [TaskStatus.Queued, TaskStatus.Thinking, TaskStatus.Working, TaskStatus.WaitingForInput, TaskStatus.WaitingForApproval];

async function main() {
  const ws = await db.workspace.create({ data: { name: 'Workforce UI Test A', slug: 'wf-ui-test-a-' + Date.now() } });
  const other = await db.workspace.create({ data: { name: 'Workforce UI Test B', slug: 'wf-ui-test-b-' + Date.now() } });
  const human = await db.user.create({ data: { email: `wf-ui-test-${Date.now()}@test.local`, passwordHash: 'x' } });
  const admin: AgentActor = { workspaceId: ws.id, role: 'admin' };
  const member: AgentActor = { workspaceId: ws.id, role: 'member' };

  try {
    const list = await db.leadList.create({ data: { workspaceId: ws.id, name: 'L' } });
    const lead = await db.lead.create({ data: { workspaceId: ws.id, listId: list.id, fullName: 'UI Test Lead', email: 'ui-test@test.local', phone: '+15550011', status: 'new' } });

    // ── permission denial: the exact gate agents/page.tsx's create() server action relies on ──
    await checkThrows('a member cannot create an agent, exactly as agents/page.tsx\'s create() action would enforce', () =>
      createAgent(member, { name: 'x', role: 'x' }));
    const agent = await createAgent(admin, { name: 'Outreach Bot', role: 'Outreach', allowedTools: ['outreach:draft', 'outreach:propose'], autonomyLevel: 'DraftAndRequestApproval' });
    const research = await createAgent(admin, { name: 'Research Bot', role: 'Research', allowedTools: ['crm:read'] });

    // ── agent details: getAgent/listTasks/listApprovals/listActivity, exactly as agents/[id]/page.tsx calls them ──
    check('getAgent returns the real agent agents/[id]/page.tsx renders', (await getAgent(ws.id, agent.id))?.name, 'Outreach Bot');
    check('getAgent returns null (not another workspace\'s agent) across a workspace boundary', await getAgent(other.id, agent.id), null);

    const researchTask = await db.agentTask.create({ data: { workspaceId: ws.id, agentId: research.id, title: 'a real task', status: 'Completed', priority: 1 } });
    check('listTasks(agentId) returns exactly this agent\'s real tasks, the shape agent details renders', (await listTasks(ws.id, { agentId: research.id })).map((t) => t.id), [researchTask.id]);
    check('listTasks scoped to another workspace never sees it', await listTasks(other.id, { agentId: research.id }), []);

    const outreachTask = await db.agentTask.create({ data: { workspaceId: ws.id, agentId: agent.id, title: 'propose outreach', status: 'Completed', priority: 1 } });

    // ── dashboard's own query set (page.tsx) — replicated exactly, not through a shared helper, since that's the page's own logic to keep or change ──
    const [agentCount, activeTaskCount, completedTaskCount, pendingApprovalCount] = await Promise.all([
      db.agent.count({ where: { workspaceId: ws.id } }),
      db.agentTask.count({ where: { workspaceId: ws.id, status: { in: ACTIVE_STATUSES } } }),
      db.agentTask.count({ where: { workspaceId: ws.id, status: TaskStatus.Completed } }),
      db.approval.count({ where: { workspaceId: ws.id, status: ApprovalState.Pending } }),
    ]);
    check('dashboard agent count matches what was actually created', agentCount, 2);
    check('dashboard completed-task count reflects both real completed tasks', completedTaskCount, 2);
    check('dashboard active-task count is 0 with no in-flight work', activeTaskCount, 0);
    check('dashboard pending-approval count is 0 before any proposal exists', pendingApprovalCount, 0);
    check('none of the dashboard counts leak into another workspace', await db.agent.count({ where: { workspaceId: other.id } }), 0);

    // ── THE BUG: approving an outreach proposal through the raw decideApproval() the Approvals page currently calls does NOT send anything ──
    const propose1 = await proposeOutreach(ws.id, agent.id, outreachTask.id, {
      leadId: lead.id, channel: 'email', subject: 'hi', body: 'hi', reason: 'ui integration test',
    });
    const decidedRaw = await decideApproval(ws.id, propose1.approval.id, 'Approved', human.id);
    check('raw decideApproval() (what approvals/page.tsx currently calls) flips the approval to Approved...', decidedRaw.status, 'Approved');
    check('...but creates NO message — this is the real bug: the send is silently never queued', await db.message.count({ where: { workspaceId: ws.id, leadId: lead.id } }), 0);

    const propose2 = await proposeOutreach(ws.id, agent.id, outreachTask.id, {
      leadId: lead.id, channel: 'whatsapp', body: 'hi', reason: 'ui integration test 2',
    });
    const decidedFixed = await decideOutreachApproval(ws.id, propose2.approval.id, 'Approved', human.id);
    check('decideOutreachApproval() — the correct function for the Approvals page to call — creates the real queued message', decidedFixed.message?.status, 'queued');

    // ── approvals list query pattern (approvals/page.tsx) — pending vs. decided split ──
    const pending = await listApprovals(ws.id, { status: ApprovalState.Pending });
    const decided = await listApprovals(ws.id, { status: ApprovalState.Approved });
    check('the pending list no longer includes either approval — both were decided above', pending.length, 0);
    check('the decided list includes both real decisions', decided.length, 2);

    // ── activity feed: real AgentActivityLog entries, not fabricated for display ──
    const activity = await listActivity(ws.id, { agentId: agent.id });
    check('the activity feed contains real, logged events for this agent\'s proposals', activity.some((a) => a.type === 'message_proposed'), true);
    check('activity is workspace-isolated too', await listActivity(other.id, { agentId: agent.id }), []);

    // ── Command Center contract (ready, not yet wired into any page) ──
    mockGroq(JSON.stringify({
      goal: 'look up the lead', tasks: [{ agentRole: 'Research', task: 'look up the lead', toolCalls: [{ tool: 'get_lead', args: { leadId: lead.id } }], dependencies: [] }],
    }));
    const preview = await previewCommand(ws.id, 'find out about our lead');
    check('previewCommand produces a real plan without creating anything', preview.steps.length, 1);
    check('a preview creates no AgentTask', await db.agentTask.count({ where: { workspaceId: ws.id, title: { contains: 'look up the lead' } } }), 0);

    const command = await executeCommand(ws.id, human.id, 'find out about our lead');
    await executeAgentTask(ws.id, command!.steps[0].id);
    const finished = await db.agentTask.findUniqueOrThrow({ where: { id: command!.root.id } });
    check('a real command submitted exactly as a future Command Center page would call it completes for real', finished.status, 'Completed');
    check('the CommandResult is real, structured data ready for a UI to render', (finished.output as CommandResult).tasksCompleted, 1);

    mockGroq('not valid json');
    const failedCommand = await executeCommand(ws.id, human.id, 'a command that will fail to plan');
    check('command failure is reported honestly, never as fake success', failedCommand!.root.status, 'Failed');

    console.log('\nall workforce UI integration checks completed');
  } finally {
    global.fetch = realFetch;
    await db.workspace.deleteMany({ where: { id: { in: [ws.id, other.id] } } });
    await db.user.delete({ where: { id: human.id } });
  }

  console.log(fails ? `\n${fails} FAILED` : '\nall workforce UI integration tests passed');
  process.exit(fails ? 1 : 0);
}

main().finally(() => db.$disconnect());
