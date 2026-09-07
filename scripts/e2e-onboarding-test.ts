/**
 * Phase 10, Section 21: one real, cohesive user journey —
 * signup -> workspace -> built-in agents -> provider configuration surface
 * -> safe AI task -> research task -> outreach proposal -> approval ->
 * Message -> Job -> worker — through the actual production functions, not
 * re-testing every edge case (each already has its own dedicated suite).
 * Real Postgres; external HTTP (AI, search, providers) mocked at the
 * boundary. Run separately from `npm test` via `npm run e2e:test`.
 */
import 'dotenv/config';
process.env.AI_PROVIDER = 'groq';
process.env.GROQ_API_KEY = 'fake-for-test';
process.env.SEARCH_PROVIDER = '';

import { PrismaClient } from '../src/generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { encrypt } from '../src/lib/crypto';
import { getOnboardingStatus } from '../src/lib/onboarding/status';
import { AGENT_TEMPLATES } from '../src/lib/agents/templates';
import { createAgent, type AgentActor } from '../src/lib/agents/agents';
import { createTask, getTask } from '../src/lib/agents/tasks';
import { executeAgentTask } from '../src/lib/agents/runtime';
import { proposeOutreach } from '../src/lib/agents/outreach';
import { decideApproval } from '../src/lib/agents/approvals';
import { sendDueMessages } from '../src/worker/sender';

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const db = new PrismaClient({ adapter });

let fails = 0;
function check(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { fails++; console.log(`FAIL ${name}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`); }
  else console.log(`pass ${name}`);
}
function checkTrue(name: string, got: boolean) { check(name, got, true); }

const realFetch = global.fetch;
function mockFetch(handler: (url: string) => Response | Promise<Response>) {
  global.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    return handler(url);
  }) as typeof fetch;
}
function json(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status }); }

async function main() {
  // ═══ 1. Signup -> workspace (the exact shape login/page.tsx's new-account path creates) ═══
  const email = `e2e-onboarding-${Date.now()}@test.local`;
  const user = await db.user.create({ data: { email, passwordHash: 'x' } });
  const ws = await db.workspace.create({
    data: { name: 'E2E Onboarding Co', slug: 'e2e-onboarding-' + Date.now(), members: { create: { userId: user.id, role: 'owner' } } },
  });
  const admin: AgentActor = { workspaceId: ws.id, role: 'owner' };

  try {
    let status = await getOnboardingStatus(ws.id);
    check('a fresh workspace starts with profile needing attention', status.steps.find((s) => s.id === 'profile')?.status, 'needs_attention');
    check('a fresh workspace has no agents yet', status.steps.find((s) => s.id === 'agents')?.status, 'not_configured');
    checkTrue('a fresh workspace is not "complete"', !status.complete);

    // ═══ 2. Profile / company info ═══
    await db.workspace.update({ where: { id: ws.id }, data: { senderName: 'E2E Tester', senderCompany: 'E2E Onboarding Co' } });
    status = await getOnboardingStatus(ws.id);
    check('profile step reflects the real update', status.steps.find((s) => s.id === 'profile')?.status, 'configured');

    // ═══ 3. Built-in AI employees — the real template architecture, not a duplicate ═══
    for (const t of AGENT_TEMPLATES) {
      await createAgent(admin, { name: t.name, role: t.role, department: t.department, objective: t.objective, allowedTools: t.allowedTools, autonomyLevel: t.autonomyLevel });
    }
    const agents = await db.agent.findMany({ where: { workspaceId: ws.id } });
    check('every built-in template was created with its own real defaults', agents.length, AGENT_TEMPLATES.length);
    checkTrue('default autonomy is safe — nothing was created Autonomous', agents.every((a) => a.autonomyLevel !== 'Autonomous'));
    status = await getOnboardingStatus(ws.id);
    check('the agents onboarding step now reflects reality', status.steps.find((s) => s.id === 'agents')?.status, 'connected');

    // ═══ 4. Provider configuration surface — real connection rows (Email/WhatsApp/SMS), same shape /mailboxes /whatsapp /sms create ═══
    await db.mailbox.create({ data: { workspaceId: ws.id, label: 'E2E Mailbox', fromName: 'E2E', fromEmail: 'e2e@test.local', provider: 'resend', apiKeyEnc: encrypt('fake-key'), status: 'active' } });
    await db.waInstance.create({ data: { workspaceId: ws.id, label: 'E2E WA', instanceName: 'e2e-wa-' + Date.now(), status: 'connected' } });
    await db.smsGateway.create({ data: { workspaceId: ws.id, label: 'E2E SMS', phoneNumber: '+15550000', apiKeyEnc: encrypt('fake-key'), status: 'connected' } });
    status = await getOnboardingStatus(ws.id);
    checkTrue('email/whatsapp/sms all report connected once real rows exist', ['email', 'whatsapp', 'sms'].every((id) => status.steps.find((s) => s.id === id)?.status === 'connected'));
    checkTrue('onboarding is now complete — every required step is real and done', status.complete);

    // ═══ 5. Safe AI task — a real, read-only summarize_lead task via the Research employee ═══
    const list = await db.leadList.create({ data: { workspaceId: ws.id, name: 'E2E List' } });
    const lead = await db.lead.create({ data: { workspaceId: ws.id, listId: list.id, fullName: 'E2E Lead', email: 'e2e-lead@test.local', phone: '+15550099', status: 'new' } });
    const researchAgent = agents.find((a) => a.role === 'Research')!;
    const sampleTask = await createTask(ws.id, { agentId: researchAgent.id, title: 'Sample research task', input: { toolCalls: [{ tool: 'summarize_lead', args: { leadId: lead.id } }] } });
    await executeAgentTask(ws.id, sampleTask.id);
    check('the safe sample AI task completes for real', (await getTask(ws.id, sampleTask.id))?.status, 'Completed');

    // ═══ 6. Research task — real web_search through the Social/Content Research employee (mocked search HTTP only) ═══
    mockFetch((url) => {
      if (url.includes('/searxng-e2e')) return json({ results: [{ title: 'E2E Result', url: 'https://example.test/e2e', content: 'a real e2e search result' }] });
      if (url.includes('api.groq.com')) return json({ choices: [{ message: { content: JSON.stringify({ subject: 'hi', body: 'Hi — real e2e outreach copy.', personalization_note: 'e2e', confidence: 80 }) } }], usage: { prompt_tokens: 5, completion_tokens: 5 } });
      return json({}, 404);
    });
    process.env.SEARCH_PROVIDER = 'searxng';
    process.env.SEARXNG_URL = 'http://127.0.0.1:1/searxng-e2e'; // never actually dialed — real fetch is mocked above
    const socialAgent = agents.find((a) => a.role === 'Social/Content Research')!;
    const researchTask = await createTask(ws.id, { agentId: socialAgent.id, title: 'Research task', input: { toolCalls: [{ tool: 'web_search', args: { query: 'e2e onboarding test' } }] } });
    await executeAgentTask(ws.id, researchTask.id);
    const researchOut = ((await getTask(ws.id, researchTask.id))?.output as { data: { status: string; results: { title: string }[] } }[] | null)?.[0]?.data;
    checkTrue('the research task runs for real and returns the mocked-provider result, not fabricated', researchOut?.status === 'ok' && researchOut.results[0]?.title === 'E2E Result');

    // ═══ 7. Outreach proposal -> Approval -> Message -> Job -> worker ═══
    const outreachAgent = agents.find((a) => a.role === 'Outreach')!;
    const outreachTask = await createTask(ws.id, { agentId: outreachAgent.id, title: 'Outreach task' });
    const proposed = await proposeOutreach(ws.id, outreachAgent.id, outreachTask.id, {
      leadId: lead.id, channel: 'email', subject: 'hi', body: 'Hi — a real e2e proposal.', reason: 'e2e onboarding journey',
    });
    check('a real Pending approval was created', proposed.approval.status, 'Pending');

    // Approve through decideApproval() — the EXACT function the Workforce Approvals UI's decide() action calls (Phase 8).
    const decided = await decideApproval(ws.id, proposed.approval.id, 'Approved', user.id);
    check('decideApproval (the real UI path) flips the approval to Approved', decided.status, 'Approved');
    checkTrue('...and materializes a real, queued Message', !!decided.messageId);
    const job = await db.job.findFirst({ where: { workspaceId: ws.id, type: 'send_message' } });
    checkTrue('a real send_message Job was enqueued', !!job);

    // Real worker function (the same one src/worker/index.ts calls) drives the send.
    await sendDueMessages(ws.id);
    const finalMessage = await db.message.findUniqueOrThrow({ where: { id: decided.messageId! } });
    checkTrue('the real worker send path drove the message to a genuine terminal state', ['sent', 'failed'].includes(finalMessage.status));

    console.log('\nfull onboarding-to-outreach journey completed for real, end to end');
  } finally {
    global.fetch = realFetch;
    await db.workspace.delete({ where: { id: ws.id } });
    await db.user.delete({ where: { id: user.id } });
  }

  console.log(fails ? `\n${fails} FAILED` : '\nall e2e onboarding journey checks passed');
  process.exit(fails ? 1 : 0);
}

main().finally(() => db.$disconnect());
