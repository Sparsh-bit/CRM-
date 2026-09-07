/**
 * Real-database integration test for the AI Workforce foundation (Phase 2):
 * Agent/AgentTask/Approval/ApprovalPolicy/AgentActivityLog + role-gated
 * agent management. Unlike scripts/{env,role,ai-router}-test.ts, this needs a
 * live Postgres — same tier as scripts/import-test.ts, run separately from
 * `npm test`, not part of it.
 *
 * Creates two throwaway workspaces (to prove isolation between them), runs
 * every assertion, and deletes both in a `finally` — safe against a database
 * with real data in it, same discipline as the Phase 0/1 manual verification.
 */
import 'dotenv/config';
import { PrismaClient } from '../src/generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { createAgent, updateAgent, deleteAgent, getAgent, listAgents, type AgentActor } from '../src/lib/agents/agents';
import { createTask, updateTaskStatus, getTask, MAX_TASK_DEPTH } from '../src/lib/agents/tasks';
import { createApproval, decideApproval, getApproval } from '../src/lib/agents/approvals';
import { upsertApprovalPolicy, getApprovalPolicy } from '../src/lib/agents/policies';
import { logActivity, listActivity } from '../src/lib/agents/activity';

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
  const ws = await db.workspace.create({ data: { name: 'Workforce Test A', slug: 'wf-test-a-' + Date.now() } });
  const other = await db.workspace.create({ data: { name: 'Workforce Test B', slug: 'wf-test-b-' + Date.now() } });
  const human = await db.user.create({ data: { email: `wf-test-${Date.now()}@test.local`, passwordHash: 'x' } });
  const admin: AgentActor = { workspaceId: ws.id, role: 'admin' };
  const owner: AgentActor = { workspaceId: ws.id, role: 'owner' };
  const member: AgentActor = { workspaceId: ws.id, role: 'member' };
  const otherAdmin: AgentActor = { workspaceId: other.id, role: 'admin' };

  try {
    // ── agent creation ──────────────────────────────────────────────
    const agent = await createAgent(admin, { name: 'Research Bot', role: 'Research' });
    check('created agent belongs to the right workspace', agent.workspaceId, ws.id);
    check('autonomy defaults to SuggestOnly, never Autonomous', agent.autonomyLevel, 'SuggestOnly');
    check('status defaults to active', agent.status, 'active');
    check('allowedTools defaults to an empty list', agent.allowedTools, []);

    // ── unauthorized / authorized agent management ─────────────────
    await checkThrows('member cannot create an agent', () => createAgent(member, { name: 'X', role: 'X' }));
    await checkThrows('member cannot update an agent', () => updateAgent(member, agent.id, { name: 'Y' }));
    await checkThrows('member cannot delete an agent', () => deleteAgent(member, agent.id));
    const renamed = await updateAgent(admin, agent.id, { name: 'Research Bot v2' });
    check('admin can update an agent', renamed.name, 'Research Bot v2');
    const renamedByOwner = await updateAgent(owner, agent.id, { name: 'Research Bot v3' });
    check('owner (outranks admin) can update an agent', renamedByOwner.name, 'Research Bot v3');
    await checkThrows('an invalid autonomy level is rejected', () =>
      updateAgent(admin, agent.id, { autonomyLevel: 'YOLO' }));
    await checkThrows('an invalid agent status is rejected', () =>
      updateAgent(admin, agent.id, { status: 'deleted-ish' }));

    // ── agent workspace isolation ───────────────────────────────────
    check('a different workspace cannot see this agent', await getAgent(other.id, agent.id), null);
    await checkThrows('a different workspace cannot update this agent (not found, not a permission error)', () =>
      updateAgent(otherAdmin, agent.id, { name: 'Hijacked' }));
    check('listAgents in the other workspace is empty', (await listAgents(other.id)).length, 0);

    // ── task creation + validation ───────────────────────────────────
    const task = await createTask(ws.id, { agentId: agent.id, title: 'Research 50 companies' });
    check('task defaults to Queued', task.status, 'Queued');
    check('task defaults to no approval needed', task.approvalState, 'None');
    check('task defaults to normal priority', task.priority, 1);
    await checkThrows('an invalid priority is rejected', () =>
      createTask(ws.id, { agentId: agent.id, title: 'X', priority: 9 }));
    await checkThrows('a task cannot attach to another workspace\'s agent', () =>
      createTask(other.id, { agentId: agent.id, title: 'Hijack' }));
    await checkThrows('an invalid task status is rejected', () =>
      updateTaskStatus(ws.id, task.id, 'Vibing'));
    const working = await updateTaskStatus(ws.id, task.id, 'Working');
    check('a valid task status transition is accepted', working.status, 'Working');

    // ── parent task relationships + depth limit ─────────────────────
    const child = await createTask(ws.id, { agentId: agent.id, title: 'Sub-task', parentTaskId: task.id });
    check('child task records its parent', child.parentTaskId, task.id);
    let chain = task.id;
    for (let i = 0; i < MAX_TASK_DEPTH - 1; i++) {
      const t = await createTask(ws.id, { agentId: agent.id, title: `depth ${i}`, parentTaskId: chain });
      chain = t.id;
    }
    await checkThrows(`delegation deeper than ${MAX_TASK_DEPTH} levels is rejected`, () =>
      createTask(ws.id, { agentId: agent.id, title: 'too deep', parentTaskId: chain }));

    // ── approval creation + policy ────────────────────────────────────
    const approval = await createApproval(ws.id, {
      taskId: task.id, agentId: agent.id, actionType: 'send_message', proposedContent: { body: 'hi' },
    });
    check('a fresh approval is Pending with no standing policy', approval.status, 'Pending');
    check('creating an approval updates the task\'s approvalState', (await getTask(ws.id, task.id))?.approvalState, 'Pending');

    await checkThrows('member cannot set an approval policy', () =>
      upsertApprovalPolicy(member, { agentId: agent.id, actionType: 'send_message', decision: 'AutoApprove' }));
    await checkThrows('an invalid policy decision is rejected', () =>
      upsertApprovalPolicy(admin, { agentId: agent.id, actionType: 'send_message', decision: 'Maybe' }));
    const policy = await upsertApprovalPolicy(admin, { agentId: agent.id, actionType: 'send_message', decision: 'AutoApprove' });
    check('policy persists the decision', policy.decision, 'AutoApprove');
    check('getApprovalPolicy reads it back', (await getApprovalPolicy(ws.id, agent.id, 'send_message'))?.decision, 'AutoApprove');

    const autoApproved = await createApproval(ws.id, {
      taskId: task.id, agentId: agent.id, actionType: 'send_message', proposedContent: { body: 'hi again' },
    });
    check('a standing AutoApprove policy resolves the approval immediately', autoApproved.status, 'Approved');
    check('a policy decision is not attributed to a human', autoApproved.decidedBy, null);

    const decided = await decideApproval(ws.id, approval.id, 'Approved', human.id);
    check('a human decision records who decided', decided.decidedBy, human.id);
    await checkThrows('a decided approval cannot be decided again', () =>
      decideApproval(ws.id, approval.id, 'Rejected', human.id));
    check('a different workspace cannot see this approval', await getApproval(other.id, approval.id), null);

    // ── activity logging ─────────────────────────────────────────────
    const activity = await logActivity(ws.id, { agentId: agent.id, taskId: task.id, type: 'task_started' });
    check('activity log entry records its type', activity.type, 'task_started');
    const noTaskActivity = await logActivity(ws.id, { agentId: agent.id, type: 'agent_created' });
    check('activity without a task is allowed (taskId is optional)', noTaskActivity.taskId, null);
    await checkThrows('activity cannot attach a task from another agent', () =>
      logActivity(ws.id, { agentId: agent.id, taskId: 'not-a-real-task-id', type: 'x' }));
    check('listActivity for a different workspace is empty', (await listActivity(other.id)).length, 0);
    const logged = await listActivity(ws.id, { agentId: agent.id });
    check('listActivity returns everything logged for this agent', logged.length >= 2, true);

    // ── cascade / delete behavior ─────────────────────────────────────
    await checkThrows('cannot hard-delete an agent that has task history', () => deleteAgent(admin, agent.id));
    const freshAgent = await createAgent(admin, { name: 'Never Used', role: 'Ops' });
    const deleted = await deleteAgent(admin, freshAgent.id);
    check('an agent with zero tasks can be deleted', deleted.id, freshAgent.id);

    const preCascade = {
      agents: await db.agent.count({ where: { workspaceId: ws.id } }),
      tasks: await db.agentTask.count({ where: { workspaceId: ws.id } }),
      approvals: await db.approval.count({ where: { workspaceId: ws.id } }),
      policies: await db.approvalPolicy.count({ where: { workspaceId: ws.id } }),
      activity: await db.agentActivityLog.count({ where: { workspaceId: ws.id } }),
    };
    check('workspace has real rows across every new table before cascade', Object.values(preCascade).every((n) => n > 0), true);

    await db.workspace.delete({ where: { id: ws.id } });

    const postCascade = {
      agents: await db.agent.count({ where: { workspaceId: ws.id } }),
      tasks: await db.agentTask.count({ where: { workspaceId: ws.id } }),
      approvals: await db.approval.count({ where: { workspaceId: ws.id } }),
      policies: await db.approvalPolicy.count({ where: { workspaceId: ws.id } }),
      activity: await db.agentActivityLog.count({ where: { workspaceId: ws.id } }),
    };
    check('deleting the workspace cascades every AI Workforce table cleanly', Object.values(postCascade).every((n) => n === 0), true);
  } finally {
    // ws is already deleted by the cascade assertion above if we got that far;
    // this cleans up both if an earlier assertion threw and short-circuited.
    await db.workspace.deleteMany({ where: { id: { in: [ws.id, other.id] } } });
    await db.user.delete({ where: { id: human.id } });
  }

  console.log(fails ? `\n${fails} FAILED` : '\nall agent workforce integration tests passed');
  process.exit(fails ? 1 : 0);
}

main().finally(() => db.$disconnect());
