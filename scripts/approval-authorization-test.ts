/**
 * Regression test for the authorization gap a security audit found:
 * src/app/workforce/approvals/page.tsx's decide() server action called
 * decideApproval() with no role check at all, so any authenticated
 * workspace member — the lowest rank — could approve or reject a real
 * outreach send. Fixed at the root: decideApproval() (src/lib/agents/
 * approvals.ts) now takes an actor { workspaceId, role } and refuses
 * anything below the admin role itself, so no future caller (a route, a
 * script, another UI) can skip the check the way the page action did.
 * Real Postgres; throwaway workspace/agent/lead deleted in the finally
 * block. Run via `npm run approval-authorization:test`.
 */
import 'dotenv/config';
process.env.AI_PROVIDER = 'groq';
process.env.GROQ_API_KEY = 'fake-for-test';

import { PrismaClient } from '../src/generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { createAgent, type AgentActor } from '../src/lib/agents/agents';
import { createTask } from '../src/lib/agents/tasks';
import { proposeOutreach } from '../src/lib/agents/outreach';
import { decideApproval } from '../src/lib/agents/approvals';

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
  const ws = await db.workspace.create({ data: { name: 'Approval Auth Test', slug: 'approval-auth-' + Date.now() } });
  const admin: AgentActor = { workspaceId: ws.id, role: 'admin' };
  const owner: AgentActor = { workspaceId: ws.id, role: 'owner' };
  const member: AgentActor = { workspaceId: ws.id, role: 'member' };
  const human = await db.user.create({ data: { email: `approval-auth-${Date.now()}@test.local`, passwordHash: 'x' } });

  try {
    const list = await db.leadList.create({ data: { workspaceId: ws.id, name: 'L' } });
    const agent = await createAgent(admin, { name: 'Outreach Bot', role: 'Outreach', allowedTools: ['outreach:propose'], autonomyLevel: 'DraftAndRequestApproval' });
    const task = await createTask(ws.id, { agentId: agent.id, title: 'approval authorization test' });

    // ═══ member cannot approve ═══
    const leadForMemberApprove = await db.lead.create({ data: { workspaceId: ws.id, listId: list.id, fullName: 'L1', email: 'l1@test.local', status: 'new' } });
    const { approval: a1 } = await proposeOutreach(ws.id, agent.id, task.id, { leadId: leadForMemberApprove.id, channel: 'email', subject: 'x', body: 'x', reason: 'x' });
    await checkThrows('a workspace member cannot approve an outreach send', () => decideApproval(member, a1.id, 'Approved', human.id));
    const a1After = await db.approval.findUniqueOrThrow({ where: { id: a1.id } });
    check('a rejected-by-role approval attempt leaves the approval Pending', a1After.status, 'Pending');
    check('a rejected-by-role approval attempt creates no Message', a1After.messageId, null);
    check('no Message row exists for the lead after a member\'s attempt was refused', await db.message.count({ where: { leadId: leadForMemberApprove.id } }), 0);

    // ═══ member cannot reject either — rejection is gated the same as approval ═══
    const leadForMemberReject = await db.lead.create({ data: { workspaceId: ws.id, listId: list.id, fullName: 'L2', email: 'l2@test.local', status: 'new' } });
    const { approval: a2 } = await proposeOutreach(ws.id, agent.id, task.id, { leadId: leadForMemberReject.id, channel: 'email', subject: 'x', body: 'x', reason: 'x' });
    await checkThrows('a workspace member cannot reject an outreach approval either', () => decideApproval(member, a2.id, 'Rejected', human.id));
    check('a member\'s refused reject attempt leaves the approval Pending', (await db.approval.findUniqueOrThrow({ where: { id: a2.id } })).status, 'Pending');

    // ═══ admin CAN approve ═══
    const decidedByAdmin = await decideApproval(admin, a1.id, 'Approved', human.id);
    check('an admin can approve the same outreach send a member was refused', decidedByAdmin.status, 'Approved');
    check('the admin\'s approval materializes a real Message', typeof decidedByAdmin.messageId === 'string', true);

    // ═══ owner CAN reject (higher rank than admin also passes) ═══
    const decidedByOwner = await decideApproval(owner, a2.id, 'Rejected', human.id);
    check('an owner can reject an outreach approval', decidedByOwner.status, 'Rejected');
    check('a rejection never creates a Message', decidedByOwner.messageId, null);

    // ═══ the thrown error is human-readable, not a raw framework error ═══
    const leadForMessageCheck = await db.lead.create({ data: { workspaceId: ws.id, listId: list.id, fullName: 'L3', email: 'l3@test.local', status: 'new' } });
    const { approval: a3 } = await proposeOutreach(ws.id, agent.id, task.id, { leadId: leadForMessageCheck.id, channel: 'email', subject: 'x', body: 'x', reason: 'x' });
    try {
      await decideApproval(member, a3.id, 'Approved', human.id);
      fails++; console.log('FAIL expected a throw for member approval, got none');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      check('the refusal message names the required role', msg.includes('admin'), true);
      check('the refusal message names the actor\'s actual role', msg.includes('member'), true);
      check('the refusal message contains no raw framework/stack noise', /PrismaClientKnownRequestError|at Object\.|node_modules/.test(msg), false);
    }

    console.log('\nall approval authorization regression checks completed');
  } finally {
    await db.workspace.delete({ where: { id: ws.id } });
    await db.user.delete({ where: { id: human.id } });
  }

  console.log(fails ? `\n${fails} FAILED` : '\nall approval authorization regression tests passed');
  process.exit(fails ? 1 : 0);
}

main().finally(() => db.$disconnect());
