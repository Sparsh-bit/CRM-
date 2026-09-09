/**
 * Regression test for the TOCTOU race a security audit found: decideApproval()
 * used to read the approval's status, check it in JS, then write — leaving a
 * window where two concurrent decisions on the same Pending approval could
 * both pass the check and both materialize a Message (a double send).
 * Fixed at the root with the same compare-and-swap pattern queue.ts's
 * claimJob() already uses: an atomic `updateMany({ where: { status: Pending
 * } })` that only one concurrent caller can ever win. Also covers the same
 * class of race one level down, in materializeApprovedMessage's own
 * messageId write. Real Postgres, real concurrency (two genuinely
 * in-flight promises against the same row, not a sequential simulation).
 * Run via `npm run approval-race:test`.
 */
import 'dotenv/config';
process.env.AI_PROVIDER = 'groq';
process.env.GROQ_API_KEY = 'fake-for-test';

import { PrismaClient } from '../src/generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { createAgent, type AgentActor } from '../src/lib/agents/agents';
import { createTask } from '../src/lib/agents/tasks';
import { proposeOutreach, materializeApprovedMessage } from '../src/lib/agents/outreach';
import { decideApproval } from '../src/lib/agents/approvals';
import { ApprovalState } from '../src/generated/prisma/enums';

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const db = new PrismaClient({ adapter });

let fails = 0;
function check(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { fails++; console.log(`FAIL ${name}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`); }
  else console.log(`pass ${name}`);
}

async function main() {
  const ws = await db.workspace.create({ data: { name: 'Approval Race Test', slug: 'approval-race-' + Date.now() } });
  const admin: AgentActor = { workspaceId: ws.id, role: 'admin' };
  const human = await db.user.create({ data: { email: `approval-race-${Date.now()}@test.local`, passwordHash: 'x' } });

  try {
    const list = await db.leadList.create({ data: { workspaceId: ws.id, name: 'L' } });
    const agent = await createAgent(admin, { name: 'Outreach Bot', role: 'Outreach', allowedTools: ['outreach:propose'], autonomyLevel: 'DraftAndRequestApproval' });
    const task = await createTask(ws.id, { agentId: agent.id, title: 'approval race test' });

    // ═══ SCENARIO 1: two concurrent decideApproval() calls on the same Pending approval ═══
    const lead = await db.lead.create({ data: { workspaceId: ws.id, listId: list.id, fullName: 'Race Lead', email: 'race@test.local', status: 'new' } });
    const { approval } = await proposeOutreach(ws.id, agent.id, task.id, { leadId: lead.id, channel: 'email', subject: 'x', body: 'x', reason: 'race scenario' });
    const jobsBefore = await db.job.count({ where: { workspaceId: ws.id, type: 'send_message' } });

    const results = await Promise.allSettled([
      decideApproval(admin, approval.id, 'Approved', human.id),
      decideApproval(admin, approval.id, 'Approved', human.id),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    check('exactly one of two concurrent decisions on the same approval succeeds', fulfilled.length, 1);
    check('exactly one of two concurrent decisions on the same approval is refused as already-decided', rejected.length, 1);
    if (rejected[0]?.status === 'rejected') {
      const msg = rejected[0].reason instanceof Error ? rejected[0].reason.message : String(rejected[0].reason);
      check('the loser\'s error says the approval was already decided', msg.includes('already decided'), true);
    }
    check('exactly one Message row was created for this lead, not two', await db.message.count({ where: { leadId: lead.id } }), 1);
    const jobsAfter = await db.job.count({ where: { workspaceId: ws.id, type: 'send_message' } });
    check('exactly one send_message Job was enqueued by the winning decision, not two', jobsAfter - jobsBefore, 1);
    const finalApproval = await db.approval.findUniqueOrThrow({ where: { id: approval.id } });
    check('the approval settled to exactly one decision (Approved), not left ambiguous', finalApproval.status, 'Approved');

    // ═══ SCENARIO 2: two concurrent materializeApprovedMessage() calls on the same already-Approved approval ═══
    // Simulates a second entry point reaching materialize concurrently (belt-and-braces below
    // decideApproval's own CAS, which already prevents this from decideApproval itself).
    const lead2 = await db.lead.create({ data: { workspaceId: ws.id, listId: list.id, fullName: 'Race Lead 2', email: 'race2@test.local', status: 'new' } });
    const { approval: approval2 } = await proposeOutreach(ws.id, agent.id, task.id, { leadId: lead2.id, channel: 'email', subject: 'x', body: 'x', reason: 'race scenario 2' });
    // Force it into Approved-but-not-yet-materialized, bypassing decideApproval's own
    // materialize call — the exact state a genuinely concurrent second caller would see.
    await db.approval.update({ where: { id: approval2.id }, data: { status: ApprovalState.Approved, decidedBy: human.id, decidedAt: new Date() } });

    const materializeResults = await Promise.all([
      materializeApprovedMessage(ws.id, approval2.id),
      materializeApprovedMessage(ws.id, approval2.id),
    ]);
    check('both concurrent materialize calls report the same messageId, not two different ones',
      materializeResults[0].message?.id, materializeResults[1].message?.id);
    check('exactly one Message row exists for this lead, not two', await db.message.count({ where: { leadId: lead2.id } }), 1);

    console.log('\nall approval race regression checks completed');
  } finally {
    await db.workspace.delete({ where: { id: ws.id } });
    await db.user.delete({ where: { id: human.id } });
  }

  console.log(fails ? `\n${fails} FAILED` : '\nall approval race regression tests passed');
  process.exit(fails ? 1 : 0);
}

main().finally(() => db.$disconnect());
