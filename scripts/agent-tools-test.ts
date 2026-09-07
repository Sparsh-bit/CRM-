/**
 * Real-database integration test for the Phase 4 business tools (CRM,
 * campaign analytics, sales intelligence, research foundation) plus their
 * permission enforcement through the real AgentRuntime. Same tier as
 * scripts/agent-{workforce,runtime}-test.ts — live Postgres, run separately
 * from `npm test` via `npm run tools:test`.
 *
 * Two layers, deliberately: most tools are checked by calling the registry
 * directly (getTool(name).handler(input, ctx)) — fast, and precise about
 * each tool's own query/filter/pagination logic. Permission enforcement and
 * cross-workspace access are checked through the real executeAgentTask(),
 * because that's the actual enforcement boundary, not the tool itself.
 */
import 'dotenv/config';
import { PrismaClient } from '../src/generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { createAgent, type AgentActor } from '../src/lib/agents/agents';
import { createTask, getTask } from '../src/lib/agents/tasks';
import { listActivity } from '../src/lib/agents/activity';
import { executeAgentTask } from '../src/lib/agents/runtime';
import { getTool } from '../src/lib/agents/registry';
import '../src/lib/agents/tools'; // registers every tool as a side effect

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const db = new PrismaClient({ adapter });

let fails = 0;
function check(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { fails++; console.log(`FAIL ${name}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`); }
  else console.log(`pass ${name}`);
}
function checkTrue(name: string, got: boolean) { check(name, got, true); }

// Every tool's outer shape is the shared { data, count, summary, metadata }
// envelope (shared.ts) — only `data`'s inner shape varies per tool, and the
// registry is necessarily type-erased (a heterogeneous Map can't keep each
// tool's own generics). `any` here is a deliberate, narrow exception for this
// test helper, not a pattern used anywhere in the tools themselves.
type ToolCallResult = { data: any; count: number; summary: string; metadata?: Record<string, unknown> }; // eslint-disable-line @typescript-eslint/no-explicit-any
async function call(name: string, input: unknown, ctx: { workspaceId: string; agentId: string; taskId: string }): Promise<ToolCallResult> {
  const tool = getTool(name);
  if (!tool) throw new Error(`Tool not registered: ${name}`);
  const parsed = tool.inputSchema.safeParse(input);
  if (!parsed.success) throw Object.assign(new Error(`invalid input for ${name}: ${parsed.error.message}`), { zod: true });
  return tool.handler(parsed.data, ctx) as Promise<ToolCallResult>;
}

async function main() {
  const ws = await db.workspace.create({ data: { name: 'Tools Test A', slug: 'tools-test-a-' + Date.now() } });
  const other = await db.workspace.create({ data: { name: 'Tools Test B', slug: 'tools-test-b-' + Date.now() } });
  const ctx = { workspaceId: ws.id, agentId: 'n/a', taskId: 'n/a' }; // agentId/taskId unused by these handlers

  try {
    // ── seed data ─────────────────────────────────────────────────────
    const list = await db.leadList.create({ data: { workspaceId: ws.id, name: 'Import 1' } });
    const now = new Date();

    const leadA = await db.lead.create({ data: { workspaceId: ws.id, listId: list.id, fullName: 'Alice A', email: 'alice@acme.test', company: 'Acme Corp', industry: 'Tech', city: 'Austin', status: 'new', score: 90, tags: ['hot'], custom: { plan: 'enterprise' } } });
    const leadB = await db.lead.create({ data: { workspaceId: ws.id, listId: list.id, fullName: 'Bob B', email: 'bob@acme.test', company: 'Acme Corp', status: 'contacted', score: 40, tags: [] } });
    const leadC = await db.lead.create({ data: { workspaceId: ws.id, listId: list.id, fullName: 'Cara C', email: 'cara@beta.test', company: 'Beta LLC', status: 'replied', score: null, tags: ['cold'] } });
    const leadD = await db.lead.create({ data: { workspaceId: ws.id, listId: list.id, fullName: 'Dan D', email: 'dan@beta.test', company: 'Beta LLC', status: 'bounced', score: 99, tags: [] } });
    const leadE = await db.lead.create({ data: { workspaceId: ws.id, listId: list.id, fullName: 'Eve E', email: 'eve@nowhere.test', status: 'new', score: 10, tags: [] } });

    const campX = await db.campaign.create({ data: { workspaceId: ws.id, listId: list.id, name: 'Campaign X', channel: 'email', status: 'running' } });
    await db.campaignStep.createMany({ data: [
      { campaignId: campX.id, order: 1, body: 'step1' },
      { campaignId: campX.id, order: 2, body: 'step2' },
    ] });
    const campY = await db.campaign.create({ data: { workspaceId: ws.id, listId: list.id, name: 'Campaign Y', channel: 'email', status: 'done' } });

    const msgA1 = await db.message.create({ data: { workspaceId: ws.id, campaignId: campX.id, leadId: leadA.id, stepOrder: 1, channel: 'email', toAddress: leadA.email!, body: 'hi', trackingId: 'trk-a1-' + Date.now(), status: 'sent', sentAt: now, openedAt: now, clickedAt: now } });
    await db.event.createMany({ data: [{ messageId: msgA1.id, type: 'open' }, { messageId: msgA1.id, type: 'click' }] });
    await db.message.create({ data: { workspaceId: ws.id, campaignId: campX.id, leadId: leadB.id, stepOrder: 1, channel: 'email', toAddress: leadB.email!, body: 'hi', trackingId: 'trk-b1-' + Date.now(), status: 'sent', sentAt: now } });
    await db.message.create({ data: { workspaceId: ws.id, campaignId: campX.id, leadId: leadB.id, stepOrder: 2, channel: 'whatsapp', toAddress: '15551234', body: 'follow up', trackingId: 'trk-b2-' + Date.now(), status: 'sent', sentAt: now, repliedAt: now } });
    const msgC1 = await db.message.create({ data: { workspaceId: ws.id, campaignId: campX.id, leadId: leadC.id, stepOrder: 1, channel: 'email', toAddress: leadC.email!, body: 'hi', trackingId: 'trk-c1-' + Date.now(), status: 'failed', error: 'smtp rejected' } });
    await db.event.create({ data: { messageId: msgC1.id, type: 'unsubscribe' } });

    // ── CRM tools ─────────────────────────────────────────────────────
    const gotA = await call('get_lead', { leadId: leadA.id }, ctx);
    check('get_lead returns the right lead', gotA.data.id, leadA.id);
    const gotMissing = await call('get_lead', { leadId: 'does-not-exist' }, ctx);
    check('get_lead returns null data for a missing id', gotMissing.data, null);
    const gotCrossWs = await call('get_lead', { leadId: leadA.id }, { ...ctx, workspaceId: other.id });
    check('get_lead never returns another workspace\'s lead', gotCrossWs.data, null);

    const newLeads = await call('list_leads', { status: 'new' }, ctx);
    check('list_leads filters by status', newLeads.count, 2);
    const hotLeads = await call('list_leads', { tag: 'hot' }, ctx);
    check('list_leads filters by tag', hotLeads.data.map((l: { id: string }) => l.id), [leadA.id]);
    const scoredLeads = await call('list_leads', { minScore: 50 }, ctx);
    checkTrue('list_leads filters by minScore', scoredLeads.data.every((l: { score: number }) => l.score >= 50));
    const paged = await call('list_leads', { limit: 1, offset: 1 }, ctx);
    check('list_leads pagination returns exactly `limit` rows', paged.data.length, 1);
    checkTrue('list_leads reports the true total count regardless of page size', paged.count === 5);

    const searched = await call('search_leads', { query: 'acme' }, ctx);
    check('search_leads matches on company', searched.count, 2);

    const activityA = await call('get_lead_activity', { leadId: leadA.id }, ctx);
    check('get_lead_activity returns this lead\'s messages', activityA.count, 1);
    checkTrue('get_lead_activity includes real recorded events', activityA.data[0].events.length === 2);
    const activityNone = await call('get_lead_activity', { leadId: leadD.id }, ctx);
    check('get_lead_activity is empty for a lead with no messages', activityNone.count, 0);

    const companies = await call('list_companies', {}, ctx);
    check('list_companies groups by company, excluding leads with none', companies.count, 2);
    const acme = companies.data.find((c: { company: string }) => c.company === 'Acme Corp');
    check('list_companies counts leads per company correctly', acme.leadCount, 2);

    const acmeDetail = await call('get_company', { company: 'Acme Corp' }, ctx);
    check('get_company aggregates lead count', acmeDetail.data.leadCount, 2);
    checkTrue('get_company aggregates industries from its leads', acmeDetail.data.industries.includes('Tech'));
    const unknownCompany = await call('get_company', { company: 'Nonexistent Inc' }, ctx);
    check('get_company returns null for a company with no leads', unknownCompany.data, null);

    // ── Campaign tools ────────────────────────────────────────────────
    const gotCampaign = await call('get_campaign', { campaignId: campX.id }, ctx);
    check('get_campaign returns the right campaign with its step count', gotCampaign.data.stepCount, 2);
    const gotCampaignMissing = await call('get_campaign', { campaignId: 'nope' }, ctx);
    check('get_campaign returns null for a missing id', gotCampaignMissing.data, null);

    const runningCampaigns = await call('list_campaigns', { status: 'running' }, ctx);
    check('list_campaigns filters by status', runningCampaigns.count, 1);

    const metricsX = await call('get_campaign_metrics', { campaignId: campX.id }, ctx);
    check('get_campaign_metrics computes real sent count', metricsX.data.sent, 3);
    check('get_campaign_metrics computes real opened count', metricsX.data.opened, 1);
    check('get_campaign_metrics computes real clicked count', metricsX.data.clicked, 1);
    check('get_campaign_metrics computes real replied count', metricsX.data.replied, 1);
    check('get_campaign_metrics computes real failed count', metricsX.data.failed, 1);
    check('get_campaign_metrics computes real unsubscribed count', metricsX.data.unsubscribed, 1);
    check('get_campaign_metrics breaks activity down by step', metricsX.data.byStep.length, 2);
    checkTrue('get_campaign_metrics names what it does not track', metricsX.data.notTracked.length > 0);

    const compared = await call('compare_campaigns', { campaignIds: [campX.id, campY.id] }, ctx);
    check('compare_campaigns returns metrics for every found campaign', compared.count, 2);
    const comparedWithMissing = await call('compare_campaigns', { campaignIds: [campX.id, 'ghost-id'] }, ctx);
    check('compare_campaigns silently drops ids that don\'t exist rather than failing', comparedWithMissing.count, 1);

    const campActivity = await call('get_campaign_activity', { campaignId: campX.id }, ctx);
    // 4 messages total under campX: leadA step1, leadB step1, leadB step2, leadC step1 (failed).
    check('get_campaign_activity returns every message for the campaign', campActivity.count, 4);

    // ── Sales tools ───────────────────────────────────────────────────
    const priority = await call('find_high_priority_leads', {}, ctx);
    check('find_high_priority_leads excludes bounced leads even with a high score', priority.data.some((l: { id: string }) => l.id === leadD.id), false);
    check('find_high_priority_leads orders by score descending, nulls last', priority.data.map((l: { id: string }) => l.id), [leadA.id, leadB.id, leadE.id, leadC.id]);

    const uncontacted = await call('identify_uncontacted_leads', {}, ctx);
    check('identify_uncontacted_leads finds status=new leads', uncontacted.data.map((l: { id: string }) => l.id).sort(), [leadA.id, leadE.id].sort());

    const replied = await call('identify_replied_leads', {}, ctx);
    check('identify_replied_leads finds status=replied leads', replied.data.map((l: { id: string }) => l.id), [leadC.id]);

    const active = await call('identify_recently_active_leads', { lookbackDays: 1 }, ctx);
    checkTrue('identify_recently_active_leads finds leads with a recent open/click/reply', active.data.some((l: { id: string }) => l.id === leadA.id) && active.data.some((l: { id: string }) => l.id === leadB.id));

    const leadHistory = await call('summarize_lead_history', { leadId: leadA.id }, ctx);
    check('summarize_lead_history counts opens correctly', leadHistory.data.opened, 1);
    checkTrue('summarize_lead_history records a last-activity timestamp', leadHistory.data.lastActivityAt !== null);

    // ── Research tools ────────────────────────────────────────────────
    const profile = await call('summarize_lead', { leadId: leadA.id }, ctx);
    check('summarize_lead surfaces custom import fields get_lead does not expose', profile.data.customFields.plan, 'enterprise');
    check('summarize_lead includes a real history rollup', profile.data.history.opened, 1);

    const perf = await call('analyze_campaign_performance', { campaignId: campX.id }, ctx);
    checkTrue('analyze_campaign_performance benchmarks against other campaigns', perf.data.workspaceBenchmark !== null || perf.data.observations.length > 0);
    checkTrue('analyze_campaign_performance produces at least one factual observation', perf.data.observations.length > 0);

    // research_external_content (the honest not-implemented stub) was retired
    // in Phase 9 — real web/social research tools now live in
    // scripts/research-test.ts (socialResearch.ts), covering the same
    // permission/schema/activity-logging plumbing plus real behavior.

    // ── permission enforcement through the real runtime ───────────────
    const admin: AgentActor = { workspaceId: ws.id, role: 'admin' };
    const crmAgent = await createAgent(admin, { name: 'CRM-only Bot', role: 'Test', allowedTools: ['crm:read'] });
    const noToolsAgent = await createAgent(admin, { name: 'No Tools Bot', role: 'Test' });

    const allowedTask = await createTask(ws.id, { agentId: crmAgent.id, title: 'read a lead', input: { toolCalls: [{ tool: 'get_lead', args: { leadId: leadA.id } }] } });
    await executeAgentTask(ws.id, allowedTask.id);
    check('an agent with crm:read can call get_lead through the real runtime', (await getTask(ws.id, allowedTask.id))?.status, 'Completed');

    const deniedTask = await createTask(ws.id, { agentId: crmAgent.id, title: 'try analytics anyway', input: { toolCalls: [{ tool: 'get_campaign_metrics', args: { campaignId: campX.id } }] } });
    await executeAgentTask(ws.id, deniedTask.id);
    const deniedResult = await getTask(ws.id, deniedTask.id);
    check('an agent without campaign:analytics is denied that tool even though it exists', deniedResult?.status, 'Failed');
    const deniedLog = await listActivity(ws.id, { agentId: crmAgent.id, taskId: deniedTask.id });
    checkTrue('the denial is logged as tool_denied, not silently skipped', deniedLog.some((a) => a.type === 'tool_denied'));

    const bypassTask = await createTask(ws.id, { agentId: noToolsAgent.id, title: 'bypass attempt', input: { toolCalls: [{ tool: 'get_lead', args: { leadId: leadA.id } }] } });
    await executeAgentTask(ws.id, bypassTask.id);
    check('an agent with zero grants cannot bypass allowedTools by naming a business tool directly', (await getTask(ws.id, bypassTask.id))?.status, 'Failed');

    console.log('\nall business tool checks completed');
  } finally {
    await db.workspace.deleteMany({ where: { id: { in: [ws.id, other.id] } } });
  }

  console.log(fails ? `\n${fails} FAILED` : '\nall agent business tools integration tests passed');
  process.exit(fails ? 1 : 0);
}

main().finally(() => db.$disconnect());
