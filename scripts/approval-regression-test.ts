/**
 * Regression test for the real bug found in Phase 8 (documented in
 * docs/workforce-integration.md): the Workforce Approvals page's decide()
 * server action calls decideApproval() (src/lib/agents/approvals.ts)
 * directly, not decideOutreachApproval() — so approving an outreach proposal
 * through the UI never materialized/queued the real Message. Fixed at the
 * root: decideApproval() is now the single authoritative decision path and
 * materializes an outreach send itself (see approvals.ts). This test drives
 * the EXACT function the UI calls, not the outreach-specific wrapper, for
 * email/WhatsApp/SMS, both Approve and Reject, plus workspace isolation and
 * one real spawned `npm run worker` process. Real Postgres; external HTTP
 * mocked in-process, run separately from `npm test` via
 * `npm run approval:test`.
 */
import 'dotenv/config';
process.env.AI_PROVIDER = 'groq';
process.env.GROQ_API_KEY = 'fake-for-test';

import { spawn } from 'node:child_process';
import { PrismaClient } from '../src/generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { encrypt } from '../src/lib/crypto';
import { createAgent, type AgentActor } from '../src/lib/agents/agents';
import { createTask } from '../src/lib/agents/tasks';
// The exact function src/app/workforce/approvals/page.tsx's decide() server
// action calls — this test never imports decideOutreachApproval for the
// Approve/Reject assertions, on purpose.
import { decideApproval, getApproval } from '../src/lib/agents/approvals';
import { proposeOutreach } from '../src/lib/agents/outreach';
import { listActivity } from '../src/lib/agents/activity';

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
function mockFetch(handler: (url: string) => Response | Promise<Response>) {
  // @ts-expect-error - test double, narrower than lib.dom's fetch
  global.fetch = async (url: string) => handler(url);
}
function jsonResponse(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status }); }

async function main() {
  const ws = await db.workspace.create({ data: { name: 'Approval Regression A', slug: 'approval-regr-a-' + Date.now() } });
  const other = await db.workspace.create({ data: { name: 'Approval Regression B', slug: 'approval-regr-b-' + Date.now() } });
  const human = await db.user.create({ data: { email: `approval-regr-${Date.now()}@test.local`, passwordHash: 'x' } });
  const admin: AgentActor = { workspaceId: ws.id, role: 'admin' };

  try {
    const list = await db.leadList.create({ data: { workspaceId: ws.id, name: 'L' } });
    const agent = await createAgent(admin, { name: 'Outreach Bot', role: 'Outreach', allowedTools: ['outreach:propose'], autonomyLevel: 'DraftAndRequestApproval' });
    const task = await createTask(ws.id, { agentId: agent.id, title: 'approval regression task' });

    // Workspace B's own resources — proves an approval decided in workspace A
    // can never touch workspace B's mailbox/instance/gateway/lead.
    const otherList = await db.leadList.create({ data: { workspaceId: other.id, name: 'L' } });
    await db.lead.create({ data: { workspaceId: other.id, listId: otherList.id, fullName: 'Other Lead', email: 'other@test.local', phone: '+15550099', status: 'new' } });

    const mailbox = await db.mailbox.create({ data: { workspaceId: ws.id, label: 'MB', fromName: 'F', fromEmail: 'f@test.local', provider: 'resend', apiKeyEnc: encrypt('k'), warmupEnabled: false } });
    const wa = await db.waInstance.create({ data: { workspaceId: ws.id, label: 'WA', instanceName: 'wa-approval-regr-' + Date.now(), status: 'connected' } });
    const gw = await db.smsGateway.create({ data: { workspaceId: ws.id, label: 'GW', phoneNumber: '+15559998', apiKeyEnc: encrypt('k'), status: 'connected' } });

    mockFetch((url) => {
      if (url.includes('api.resend.com')) return jsonResponse({ id: 'resend-regr-1' });
      if (url.includes('/message/sendText')) return jsonResponse({ key: { id: 'wa-regr-1' } });
      if (url.includes('/v1/messages/send')) return jsonResponse({ status: 'success', message: 'ok', data: { id: 'sms-regr-1', status: 'pending' } });
      return jsonResponse({}, 404);
    });

    // ═══ EMAIL / WHATSAPP / SMS, each: propose -> decideApproval('Approved') (the UI's exact path) -> Message + Job + activity ═══
    const channels: { channel: 'email' | 'whatsapp' | 'sms'; leadEmail?: string; leadPhone?: string; subject?: string }[] = [
      { channel: 'email', leadEmail: 'email-lead@test.local', subject: 'hi' },
      { channel: 'whatsapp', leadPhone: '+15550091' },
      { channel: 'sms', leadPhone: '+15550092' },
    ];

    for (const c of channels) {
      const lead = await db.lead.create({ data: { workspaceId: ws.id, listId: list.id, fullName: `${c.channel} lead`, email: c.leadEmail ?? null, phone: c.leadPhone ?? null, status: 'new' } });
      const jobsBefore = await db.job.count({ where: { workspaceId: ws.id, type: 'send_message' } });

      const { approval } = await proposeOutreach(ws.id, agent.id, task.id, {
        leadId: lead.id, channel: c.channel, body: `hi via ${c.channel}`, subject: c.subject, reason: 'approval regression test',
      });
      check(`[${c.channel}] cross-workspace: workspace B cannot decide workspace A's approval`, await (async () => {
        try { await decideApproval(other.id, approval.id, 'Approved', human.id); return 'did not throw'; }
        catch { return 'threw'; }
      })(), 'threw');

      const decided = await decideApproval(ws.id, approval.id, 'Approved', human.id);
      check(`[${c.channel}] decideApproval (the UI's exact call) flips the approval to Approved`, decided.status, 'Approved');
      check(`[${c.channel}] decideApproval materializes a real Message id on the approval`, typeof decided.messageId === 'string', true);

      const message = decided.messageId ? await db.message.findUnique({ where: { id: decided.messageId } }) : null;
      check(`[${c.channel}] a real, queued Message was created`, message?.status, 'queued');
      check(`[${c.channel}] the Message carries the right channel`, message?.channel, c.channel);
      check(`[${c.channel}] the Message is linked back to the workspace, not leaked cross-workspace`, message?.workspaceId, ws.id);

      const jobsAfter = await db.job.count({ where: { workspaceId: ws.id, type: 'send_message' } });
      check(`[${c.channel}] a real send_message Job was enqueued`, jobsAfter > jobsBefore, true);

      const activity = await listActivity(ws.id, { agentId: agent.id, taskId: task.id });
      for (const type of ['approval_approved', 'message_created', 'message_queued']) {
        check(`[${c.channel}] AgentActivityLog contains "${type}"`, activity.some((a) => a.type === type), true);
      }
    }

    // ═══ REJECT: no Message, no Job, only approval_rejected logged ═══
    const rejectLead = await db.lead.create({ data: { workspaceId: ws.id, listId: list.id, fullName: 'Reject Lead', email: 'reject-lead@test.local', status: 'new' } });
    const jobsBeforeReject = await db.job.count({ where: { workspaceId: ws.id, type: 'send_message' } });
    const { approval: rejectApproval } = await proposeOutreach(ws.id, agent.id, task.id, {
      leadId: rejectLead.id, channel: 'email', subject: 'x', body: 'x', reason: 'reject path',
    });
    const rejected = await decideApproval(ws.id, rejectApproval.id, 'Rejected', human.id);
    check('reject: the approval flips to Rejected', rejected.status, 'Rejected');
    check('reject: no messageId was ever set', rejected.messageId, null);
    check('reject: no Message row exists for this lead', await db.message.count({ where: { leadId: rejectLead.id } }), 0);
    check('reject: no new send_message Job was enqueued', await db.job.count({ where: { workspaceId: ws.id, type: 'send_message' } }), jobsBeforeReject);
    const rejectActivity = await listActivity(ws.id, { agentId: agent.id, taskId: task.id });
    const rejectApprovalActivity = rejectActivity.filter((a) => (a.meta as { approvalId?: string } | null)?.approvalId === rejectApproval.id);
    check('reject: approval_rejected was logged', rejectApprovalActivity.some((a) => a.type === 'approval_rejected'), true);
    check('reject: message_created was never logged for this approval', rejectApprovalActivity.some((a) => a.type === 'message_created'), false);

    await checkThrows('a decided approval cannot be decided again through decideApproval', () =>
      decideApproval(ws.id, rejectApproval.id, 'Approved', human.id));

    // ═══ REAL WORKER: one approved email actually claimed and driven by a real, separate `npm run worker` process ═══
    const realWorkerLead = await db.lead.create({ data: { workspaceId: ws.id, listId: list.id, fullName: 'Real Worker Lead', email: 'real-worker@test.local', status: 'new' } });
    const { approval: rwApproval } = await proposeOutreach(ws.id, agent.id, task.id, {
      leadId: realWorkerLead.id, channel: 'email', subject: 'real worker', body: 'real worker body', reason: 'real worker regression',
    });
    const rwDecided = await decideApproval(ws.id, rwApproval.id, 'Approved', human.id);
    const rwMessageId = rwDecided.messageId!;
    check('real-worker setup: the message to drive is queued before the worker runs', (await db.message.findUnique({ where: { id: rwMessageId } }))?.status, 'queued');

    console.log('\nspawning a real `npm run worker` process against the same database...');
    const finalStatus = await runRealWorkerUntilTerminal(rwMessageId);
    check('real-worker: a separate npm run worker process drove the queued Message to a real terminal state (sent or failed — either proves the Job -> worker -> sender pipeline actually ran)', ['sent', 'failed'].includes(finalStatus ?? ''), true);

    console.log('\nall approval regression checks completed');
  } finally {
    global.fetch = realFetch;
    await db.workspace.deleteMany({ where: { id: { in: [ws.id, other.id] } } });
    await db.user.delete({ where: { id: human.id } });
  }

  console.log(fails ? `\n${fails} FAILED` : '\nall approval regression tests passed');
  process.exit(fails ? 1 : 0);
}

/** Spawns the real worker process (same DATABASE_URL, no fetch mocking — a real HTTP attempt happens) and polls the DB for the message to leave 'queued'. Always kills the spawned process before returning. */
async function runRealWorkerUntilTerminal(messageId: string, timeoutMs = 25_000): Promise<string | undefined> {
  const child = spawn('npx', ['tsx', 'src/worker/index.ts'], {
    env: { ...process.env, WORKER_TICK_MS: '500' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout?.on('data', (d) => { out += String(d); });
  child.stderr?.on('data', (d) => { out += String(d); });

  try {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const msg = await db.message.findUnique({ where: { id: messageId } });
      if (msg && msg.status !== 'queued') return msg.status;
      await new Promise((r) => setTimeout(r, 500));
    }
    console.log('real worker did not reach a terminal state in time; last output:\n' + out.slice(-1000));
    return undefined;
  } finally {
    child.kill('SIGTERM');
  }
}

main().finally(() => db.$disconnect());
