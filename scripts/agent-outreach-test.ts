/**
 * Real-database integration test for Phase 6: agent-proposed outreach
 * (the prepare_email/whatsapp/sms and propose_send tools, Approval-gated
 * Message creation, and execution through the real send path) across
 * email, WhatsApp and SMS. Same tier as the other scripts/agent-*-test.ts
 * scripts — live Postgres, external HTTP mocked, run separately from
 * `npm test` via `npm run outreach:test`.
 */
import 'dotenv/config';
process.env.AI_PROVIDER = 'groq';
process.env.GROQ_API_KEY = 'fake-for-test';

import { PrismaClient } from '../src/generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { encrypt } from '../src/lib/crypto';
import { createAgent, type AgentActor } from '../src/lib/agents/agents';
import { createTask, getTask } from '../src/lib/agents/tasks';
import { upsertApprovalPolicy } from '../src/lib/agents/policies';
import { getApproval, listApprovals } from '../src/lib/agents/approvals';
import { listActivity } from '../src/lib/agents/activity';
import { decideOutreachApproval } from '../src/lib/agents/outreach';
import { executeAgentTask } from '../src/lib/agents/runtime';
import { sendDueMessages } from '../src/worker/sender';

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

const GROQ_DRAFT_OK = {
  choices: [{ message: { content: JSON.stringify({ subject: 'quick question', body: 'Hi — noticed your work, one quick question.', personalization_note: 'used their industry', confidence: 82 }) } }],
  usage: { prompt_tokens: 10, completion_tokens: 10 },
};

async function runTask(workspaceId: string, agentId: string, toolCalls: { tool: string; args: Record<string, unknown> }[]) {
  const task = await createTask(workspaceId, { agentId, title: 'outreach task', input: { toolCalls } });
  await executeAgentTask(workspaceId, task.id);
  return getTask(workspaceId, task.id);
}

/** Unwraps the first tool call's result down to its `data` — every tool returns { data, count, summary, metadata } (shared.ts). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function firstResultData(task: { output: unknown } | null | undefined): any {
  const outputs = task?.output as { data: unknown }[] | null | undefined;
  return outputs?.[0]?.data;
}

async function main() {
  const ws = await db.workspace.create({ data: { name: 'Outreach Test A', slug: 'outreach-test-a-' + Date.now() } });
  const other = await db.workspace.create({ data: { name: 'Outreach Test B', slug: 'outreach-test-b-' + Date.now() } });
  const admin: AgentActor = { workspaceId: ws.id, role: 'admin' };
  const human = await db.user.create({ data: { email: `outreach-test-${Date.now()}@test.local`, passwordHash: 'x' } });

  try {
    const list = await db.leadList.create({ data: { workspaceId: ws.id, name: 'L' } });
    const lead = await db.lead.create({ data: { workspaceId: ws.id, listId: list.id, fullName: 'Pat Lead', email: 'pat@test.local', phone: '+15550003', status: 'new' } });
    const emailOnlyLead = await db.lead.create({ data: { workspaceId: ws.id, listId: list.id, fullName: 'No Phone', email: 'nophone@test.local', status: 'new' } });
    const suppressedLead = await db.lead.create({ data: { workspaceId: ws.id, listId: list.id, fullName: 'Supp Lead', email: 'suppressed@test.local', phone: '+15550004', status: 'new' } });
    await db.suppression.createMany({ data: [
      { workspaceId: ws.id, value: 'suppressed@test.local', kind: 'email' },
      { workspaceId: ws.id, value: '+15550004', kind: 'phone' },
    ] });

    const otherList = await db.leadList.create({ data: { workspaceId: other.id, name: 'L' } });
    const otherLead = await db.lead.create({ data: { workspaceId: other.id, listId: otherList.id, fullName: 'Other Lead', email: 'o@test.local', phone: '+15550005', status: 'new' } });

    const agent = await createAgent(admin, { name: 'Outreach Bot', role: 'Outreach', allowedTools: ['outreach:draft', 'outreach:propose'], autonomyLevel: 'DraftAndRequestApproval' });
    const suggestOnlyAgent = await createAgent(admin, { name: 'Suggest Bot', role: 'Outreach', allowedTools: ['outreach:draft', 'outreach:propose'], autonomyLevel: 'SuggestOnly' });
    const noPermAgent = await createAgent(admin, { name: 'No Perm Bot', role: 'Outreach', allowedTools: ['outreach:draft'], autonomyLevel: 'DraftAndRequestApproval' });

    // ── real communication resources (connected, mocked HTTP) ──────────
    const mailbox = await db.mailbox.create({ data: { workspaceId: ws.id, label: 'MB', fromName: 'F', fromEmail: 'f@test.local', provider: 'resend', apiKeyEnc: encrypt('k'), warmupEnabled: false } });
    const wa = await db.waInstance.create({ data: { workspaceId: ws.id, label: 'WA', instanceName: 'wa-outreach-' + Date.now(), status: 'connected' } });
    const gw = await db.smsGateway.create({ data: { workspaceId: ws.id, label: 'GW', phoneNumber: '+15559999', apiKeyEnc: encrypt('k'), status: 'connected' } });
    // Agent-proposed messages have campaignId: null, so sendDueMessages's
    // sending-window check (gated on `if (campaign)`) never applies to them
    // — there is no campaign to read a window from. The real governor that
    // DOES apply is per-mailbox/instance/gateway daily-limit/min-gap/jitter,
    // exercised below exactly as it already is for human campaigns.

    mockFetch((url) => {
      if (url.includes('api.groq.com')) return jsonResponse(GROQ_DRAFT_OK);
      if (url.includes('api.resend.com')) return jsonResponse({ id: 'resend-1' });
      if (url.includes('/message/sendText')) return jsonResponse({ key: { id: 'wa-1' } });
      if (url.includes('/v1/messages/send')) return jsonResponse({ status: 'success', message: 'ok', data: { id: 'hsms-1', status: 'pending' } });
      return jsonResponse({}, 404);
    });

    // ── prepare_* drafts the message via the EXISTING AI writer, no second engine ──
    const draftTask = await runTask(ws.id, agent.id, [{ tool: 'prepare_email', args: { leadId: lead.id, purpose: 'introduce our services' } }]);
    check('prepare_email completes and drafts via the real writer pipeline', draftTask?.status, 'Completed');
    const draftOutput = firstResultData(draftTask) as { subject: string; body: string } | undefined;
    check('the draft came from the mocked AI response, not fabricated', draftOutput?.subject, 'quick question');

    // ── SECURITY: SuggestOnly cannot open a proposal at all ─────────────
    const bypassTask = await runTask(ws.id, suggestOnlyAgent.id, [{ tool: 'propose_send', args: { leadId: lead.id, channel: 'email', subject: 'x', body: 'x', reason: 'x' } }]);
    check('a SuggestOnly agent cannot propose_send — autonomy gate enforced', bypassTask?.status, 'Failed');
    check('SuggestOnly is refused for the stated reason, not a generic error', bypassTask?.failureReason?.includes('Suggest Only'), true);

    // ── SECURITY: no outreach:propose permission ────────────────────────
    const noPermTask = await runTask(ws.id, noPermAgent.id, [{ tool: 'propose_send', args: { leadId: lead.id, channel: 'email', subject: 'x', body: 'x', reason: 'x' } }]);
    check('an agent without outreach:propose is denied the tool, not the autonomy check', noPermTask?.status, 'Failed');
    check('the denial is a permission denial specifically', noPermTask?.failureReason?.includes('not permitted'), true);

    // ── SECURITY: suppressed recipient ───────────────────────────────────
    const suppTask = await runTask(ws.id, agent.id, [{ tool: 'propose_send', args: { leadId: suppressedLead.id, channel: 'email', subject: 'x', body: 'x', reason: 'x' } }]);
    check('propose_send refuses a suppressed recipient outright', suppTask?.status, 'Failed');
    check('no approval was created for the suppressed recipient', (await listApprovals(ws.id)).some((a) => JSON.stringify(a.proposedContent).includes(suppressedLead.id)), false);

    // ── SECURITY: invalid recipient (no phone for whatsapp) ─────────────
    const noPhoneTask = await runTask(ws.id, agent.id, [{ tool: 'propose_send', args: { leadId: emailOnlyLead.id, channel: 'whatsapp', body: 'x', reason: 'x' } }]);
    check('propose_send refuses a lead with no phone for a phone channel', noPhoneTask?.status, 'Failed');

    // ── SECURITY / workspace isolation: cross-workspace lead ────────────
    const crossWsTask = await runTask(ws.id, agent.id, [{ tool: 'propose_send', args: { leadId: otherLead.id, channel: 'email', subject: 'x', body: 'x', reason: 'x' } }]);
    check('propose_send cannot target a lead from another workspace', crossWsTask?.status, 'Failed');

    // ═══════════════════════ EMAIL: proposal -> approval -> execution ═══
    const emailPropose = await runTask(ws.id, agent.id, [{ tool: 'propose_send', args: { leadId: lead.id, channel: 'email', subject: 'quick question', body: 'Hi Pat, quick one.', reason: 'cold intro' } }]);
    check('email proposal task completes', emailPropose?.status, 'Completed');
    const emailApprovalId = firstResultData(emailPropose)?.approvalId;
    const emailApproval = await getApproval(ws.id, emailApprovalId);
    check('email proposal creates a Pending approval, no message yet', emailApproval?.status, 'Pending');
    check('no message exists before approval', emailApproval?.messageId, null);
    const emailLog = await listActivity(ws.id, { agentId: agent.id, taskId: emailPropose!.id });
    check('message_proposed and approval_requested were logged', ['message_proposed', 'approval_requested'].every((t) => emailLog.some((a) => a.type === t)), true);

    // workspace isolation on the decision itself
    await checkThrows('another workspace cannot decide this approval', () => decideOutreachApproval(other.id, emailApprovalId, 'Approved', human.id));

    const emailDecided = await decideOutreachApproval(ws.id, emailApprovalId, 'Approved', human.id);
    check('approving creates a real, queued Message', emailDecided.message?.status, 'queued');
    check('the message is linked back to the task that proposed it', emailDecided.message?.agentTaskId, emailPropose!.id);
    await checkThrows('the same approval cannot be decided twice (repeated approval)', () => decideOutreachApproval(ws.id, emailApprovalId, 'Rejected', human.id));

    await sendDueMessages(ws.id);
    const emailSent = await db.message.findUniqueOrThrow({ where: { id: emailDecided.message!.id } });
    check('the real worker send path marks the email sent', emailSent.status, 'sent');
    check('a real provider id is recorded', emailSent.providerId, 'resend-1');
    const sentLog = await listActivity(ws.id, { agentId: agent.id, taskId: emailPropose!.id });
    check('message_created, message_queued, approval_approved and message_sent were all logged', ['message_created', 'message_queued', 'approval_approved', 'message_sent'].every((t) => sentLog.some((a) => a.type === t)), true);

    // ── EMAIL: rejection ─────────────────────────────────────────────────
    const emailRejectPropose = await runTask(ws.id, agent.id, [{ tool: 'propose_send', args: { leadId: emailOnlyLead.id, channel: 'email', subject: 'x', body: 'x', reason: 'x' } }]);
    const emailRejectId = firstResultData(emailRejectPropose)?.approvalId;
    const rejected = await decideOutreachApproval(ws.id, emailRejectId, 'Rejected', human.id);
    check('rejecting creates no message', rejected.message, null);
    check('rejected messages count stays zero for this lead', await db.message.count({ where: { leadId: emailOnlyLead.id } }), 0);

    // ── EMAIL: failure ────────────────────────────────────────────────────
    mockFetch((url) => {
      if (url.includes('api.resend.com')) return jsonResponse({ message: 'invalid from address' }, 422);
      return jsonResponse({}, 404);
    });
    await db.mailbox.update({ where: { id: mailbox.id }, data: { lastSentAt: null } }); // clear the min-gap from the earlier successful send
    const emailFailPropose = await runTask(ws.id, agent.id, [{ tool: 'propose_send', args: { leadId: emailOnlyLead.id, channel: 'email', subject: 'x', body: 'x', reason: 'x' } }]);
    const emailFailId = firstResultData(emailFailPropose)?.approvalId;
    const emailFailDecided = await decideOutreachApproval(ws.id, emailFailId, 'Approved', human.id);
    await sendDueMessages(ws.id);
    const emailFailedMsg = await db.message.findUniqueOrThrow({ where: { id: emailFailDecided.message!.id } });
    check('a real provider rejection marks the message failed, not sent', emailFailedMsg.status, 'failed');
    const failLog = await listActivity(ws.id, { agentId: agent.id, taskId: emailFailPropose!.id });
    check('message_failed was logged for the agent-originated failure', failLog.some((a) => a.type === 'message_failed'), true);

    // ═══════════════════════ WHATSAPP: proposal -> approval -> execution ═
    mockFetch((url) => {
      if (url.includes('/message/sendText')) return jsonResponse({ key: { id: 'wa-1' } });
      return jsonResponse({}, 404);
    });
    const waPropose = await runTask(ws.id, agent.id, [{ tool: 'propose_send', args: { leadId: lead.id, channel: 'whatsapp', body: 'Hi Pat, quick one.', reason: 'cold intro' } }]);
    const waApprovalId = firstResultData(waPropose)?.approvalId;
    const waDecided = await decideOutreachApproval(ws.id, waApprovalId, 'Approved', human.id);
    check('WhatsApp approval creates a queued message', waDecided.message?.status, 'queued');
    await sendDueMessages(ws.id);
    check('the real worker sends the WhatsApp message', (await db.message.findUniqueOrThrow({ where: { id: waDecided.message!.id } })).status, 'sent');

    // suppression blocks a phone channel too, not just email
    const suppPhoneTask = await runTask(ws.id, agent.id, [{ tool: 'propose_send', args: { leadId: suppressedLead.id, channel: 'sms', body: 'x', reason: 'x' } }]);
    check('a suppressed lead cannot be proposed on any channel, not just email', suppPhoneTask?.status, 'Failed');

    // WhatsApp failure
    mockFetch((url) => {
      if (url.includes('/message/sendText')) return jsonResponse({ message: 'instance not connected' }, 500);
      return jsonResponse({}, 404);
    });
    await db.waInstance.update({ where: { id: wa.id }, data: { lastSentAt: null } }); // clear the min-gap from the prior send
    const waFailLead = await db.lead.create({ data: { workspaceId: ws.id, listId: list.id, fullName: 'Wa Fail Lead', phone: '+15550009', status: 'new' } });
    const waFailPropose = await runTask(ws.id, agent.id, [{ tool: 'propose_send', args: { leadId: waFailLead.id, channel: 'whatsapp', body: 'x', reason: 'x' } }]);
    const waFailId = firstResultData(waFailPropose)?.approvalId;
    const waFailDecided = await decideOutreachApproval(ws.id, waFailId, 'Approved', human.id);
    await sendDueMessages(ws.id);
    check('a real provider failure marks the whatsapp message failed', (await db.message.findUniqueOrThrow({ where: { id: waFailDecided.message!.id } })).status, 'failed');

    // ═══════════════════════ SMS: proposal -> approval -> execution ══════
    mockFetch((url) => {
      if (url.includes('/v1/messages/send')) return jsonResponse({ status: 'success', message: 'ok', data: { id: 'hsms-1', status: 'pending' } });
      return jsonResponse({}, 404);
    });
    const smsLead = await db.lead.create({ data: { workspaceId: ws.id, listId: list.id, fullName: 'Sms Lead', phone: '+15550006', status: 'new' } });
    const smsPropose = await runTask(ws.id, agent.id, [{ tool: 'propose_send', args: { leadId: smsLead.id, channel: 'sms', body: 'Hi, quick one.', reason: 'cold intro' } }]);
    const smsApprovalId = firstResultData(smsPropose)?.approvalId;
    const smsDecided = await decideOutreachApproval(ws.id, smsApprovalId, 'Approved', human.id);
    check('SMS approval creates a queued message', smsDecided.message?.status, 'queued');
    await sendDueMessages(ws.id);
    check('the real worker sends the sms message', (await db.message.findUniqueOrThrow({ where: { id: smsDecided.message!.id } })).status, 'sent');

    // SMS failure
    mockFetch((url) => {
      if (url.includes('/v1/messages/send')) return jsonResponse({ status: 'error', message: 'invalid number' }, 422);
      return jsonResponse({}, 404);
    });
    await db.smsGateway.update({ where: { id: gw.id }, data: { lastSentAt: null } }); // clear the min-gap from the earlier successful send
    const smsLead2 = await db.lead.create({ data: { workspaceId: ws.id, listId: list.id, fullName: 'Sms Lead 2', phone: '+15550007', status: 'new' } });
    const smsFailPropose = await runTask(ws.id, agent.id, [{ tool: 'propose_send', args: { leadId: smsLead2.id, channel: 'sms', body: 'x', reason: 'x' } }]);
    const smsFailId = firstResultData(smsFailPropose)?.approvalId;
    const smsFailDecided = await decideOutreachApproval(ws.id, smsFailId, 'Approved', human.id);
    await sendDueMessages(ws.id);
    check('a real provider rejection marks the sms message failed', (await db.message.findUniqueOrThrow({ where: { id: smsFailDecided.message!.id } })).status, 'failed');

    // ── AUTONOMY: an explicit ApprovalPolicy auto-approves without a human ──
    await upsertApprovalPolicy(admin, { agentId: agent.id, actionType: 'send_sms', decision: 'AutoApprove' });
    const smsLead3 = await db.lead.create({ data: { workspaceId: ws.id, listId: list.id, fullName: 'Sms Lead 3', phone: '+15550008', status: 'new' } });
    mockFetch((url) => {
      if (url.includes('/v1/messages/send')) return jsonResponse({ status: 'success', message: 'ok', data: { id: 'hsms-auto', status: 'pending' } });
      return jsonResponse({}, 404);
    });
    const autoTask = await runTask(ws.id, agent.id, [{ tool: 'propose_send', args: { leadId: smsLead3.id, channel: 'sms', body: 'auto', reason: 'policy test' } }]);
    const autoOutput = firstResultData(autoTask);
    check('a standing AutoApprove policy resolves the proposal immediately, no human step', autoOutput?.status, 'Approved');
    check('the policy auto-approval already created a real, queued message', autoOutput?.messageId !== null, true);

    // ── IDEMPOTENCY: duplicate proposal for the same agent+channel+lead ──
    const dup1 = await runTask(ws.id, agent.id, [{ tool: 'propose_send', args: { leadId: lead.id, channel: 'email', subject: 'again', body: 'again', reason: 'dup test' } }]);
    const dup2 = await runTask(ws.id, agent.id, [{ tool: 'propose_send', args: { leadId: lead.id, channel: 'email', subject: 'again again', body: 'again again', reason: 'dup test 2' } }]);
    const dup1Id = firstResultData(dup1)?.approvalId;
    const dup2Id = firstResultData(dup2)?.approvalId;
    check('a second propose_send for the same agent+channel+lead returns the SAME approval, not a new one', dup2Id, dup1Id);

    console.log('\nall outreach checks completed');
  } finally {
    global.fetch = realFetch;
    await db.workspace.deleteMany({ where: { id: { in: [ws.id, other.id] } } });
    await db.user.delete({ where: { id: human.id } });
  }

  console.log(fails ? `\n${fails} FAILED` : '\nall agent outreach integration tests passed');
  process.exit(fails ? 1 : 0);
}

main().finally(() => db.$disconnect());
