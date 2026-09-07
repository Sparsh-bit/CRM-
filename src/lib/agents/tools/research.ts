/**
 * Read-only analysis tools that combine existing data into a richer
 * structured view than a single CRM/campaign lookup gives — still no
 * invented content, no LLM call inside a tool (an agent's own reasoning step
 * decides what to do with these facts; the tool only assembles them).
 *
 * summarize_company was deliberately not added as a separate tool: it would
 * return exactly what get_company (crm.ts) already returns. research.ts
 * only holds tools that combine data get_lead/get_campaign_metrics alone
 * don't — see docs/agent-tools.md.
 */
import { z } from 'zod';
import { db } from '../../db';
import { registerTool } from '../registry';
import { LEAD_SELECT, leadSummarySchema, serializeLead } from './crm';
import { computeCampaignMetrics } from './campaigns';
import { resultSchema, toolResult } from './shared';

// ── summarize_lead ───────────────────────────────────────────────────────
const leadProfileSchema = z.object({
  lead: leadSummarySchema,
  customFields: z.record(z.string(), z.unknown()),
  history: z.object({
    totalMessages: z.number(),
    byChannel: z.record(z.string(), z.number()),
    opened: z.number(),
    clicked: z.number(),
    replied: z.number(),
    lastActivityAt: z.string().nullable(),
  }),
});

registerTool({
  name: 'summarize_lead',
  description:
    'The fullest structured profile of one lead in a single call: canonical fields, every custom column kept from the original import, and a real message-history rollup. Facts only — combines get_lead + the imported custom data + summarize_lead_history\'s counts; does not generate prose.',
  inputSchema: z.object({ leadId: z.string().min(1) }),
  outputSchema: resultSchema(leadProfileSchema.nullable()),
  requiredPermission: 'research:analysis',
  category: 'research',
  readOnly: true,
  idempotent: true,
  handler: async (input, ctx) => {
    const lead = await db.lead.findFirst({
      where: { id: input.leadId, workspaceId: ctx.workspaceId },
      select: { ...LEAD_SELECT, custom: true },
    });
    if (!lead) return toolResult(null, 0, 'No lead found with that id in this workspace.');

    const messages = await db.message.findMany({
      where: { leadId: lead.id, workspaceId: ctx.workspaceId },
      select: { channel: true, openedAt: true, clickedAt: true, repliedAt: true, sentAt: true },
    });
    const byChannel: Record<string, number> = {};
    for (const m of messages) byChannel[m.channel] = (byChannel[m.channel] ?? 0) + 1;
    const timestamps = messages.flatMap((m) => [m.openedAt, m.clickedAt, m.repliedAt, m.sentAt].filter((d): d is Date => d !== null));
    const lastActivityAt = timestamps.length ? new Date(Math.max(...timestamps.map((d) => d.getTime()))).toISOString() : null;

    const data = {
      lead: serializeLead(lead),
      customFields: (lead.custom ?? {}) as Record<string, unknown>,
      history: {
        totalMessages: messages.length, byChannel,
        opened: messages.filter((m) => m.openedAt !== null).length,
        clicked: messages.filter((m) => m.clickedAt !== null).length,
        replied: messages.filter((m) => m.repliedAt !== null).length,
        lastActivityAt,
      },
    };
    return toolResult(data, 1, `Profile assembled for ${lead.fullName ?? lead.email ?? lead.id}.`);
  },
});

// ── analyze_campaign_performance ──────────────────────────────────────────
const performanceSchema = z.object({
  campaign: z.object({ id: z.string(), name: z.string() }),
  metrics: z.record(z.string(), z.unknown()),
  workspaceBenchmark: z.object({
    campaignsCompared: z.number(),
    avgOpenRate: z.number().nullable(),
    avgClickRate: z.number().nullable(),
    avgReplyRate: z.number().nullable(),
  }).nullable(),
  observations: z.array(z.string()),
});

registerTool({
  name: 'analyze_campaign_performance',
  description:
    'get_campaign_metrics for one campaign, plus a benchmark against this workspace\'s other campaigns and a few factual, templated observations (e.g. "reply rate is above/below the workspace average"). Every observation is a deterministic comparison of real numbers, not an AI-generated opinion.',
  inputSchema: z.object({ campaignId: z.string().min(1) }),
  outputSchema: resultSchema(performanceSchema.nullable()),
  requiredPermission: 'research:analysis',
  category: 'research',
  readOnly: true,
  idempotent: true,
  handler: async (input, ctx) => {
    const metrics = await computeCampaignMetrics(ctx.workspaceId, input.campaignId);
    if (!metrics) return toolResult(null, 0, 'No campaign found with that id in this workspace.');

    const others = await db.campaign.findMany({
      where: { workspaceId: ctx.workspaceId, id: { not: input.campaignId } },
      select: { id: true },
    });
    const otherMetrics = (await Promise.all(others.map((c) => computeCampaignMetrics(ctx.workspaceId, c.id))))
      .filter((m): m is NonNullable<typeof m> => m !== null && m.sent > 0);

    const avg = (key: 'openRate' | 'clickRate' | 'replyRate') => {
      const rates = otherMetrics.map((m) => m[key]).filter((r): r is number => r !== null);
      return rates.length ? Math.round((rates.reduce((a, b) => a + b, 0) / rates.length) * 1000) / 1000 : null;
    };
    const workspaceBenchmark = otherMetrics.length
      ? { campaignsCompared: otherMetrics.length, avgOpenRate: avg('openRate'), avgClickRate: avg('clickRate'), avgReplyRate: avg('replyRate') }
      : null;

    const observations: string[] = [];
    if (metrics.sent === 0) {
      observations.push('This campaign has not sent any messages yet — no rates can be computed.');
    } else if (!workspaceBenchmark) {
      observations.push('No other campaign with sends exists in this workspace yet, so no benchmark comparison is available.');
    } else {
      const compare = (label: string, rate: number | null, benchmark: number | null) => {
        if (rate === null || benchmark === null) return;
        const diff = Math.round((rate - benchmark) * 1000) / 1000;
        if (Math.abs(diff) < 0.01) observations.push(`${label} rate (${rate}) is about the same as the workspace average (${benchmark}).`);
        else observations.push(`${label} rate (${rate}) is ${diff > 0 ? 'above' : 'below'} the workspace average (${benchmark}).`);
      };
      compare('Open', metrics.openRate, workspaceBenchmark.avgOpenRate);
      compare('Click', metrics.clickRate, workspaceBenchmark.avgClickRate);
      compare('Reply', metrics.replyRate, workspaceBenchmark.avgReplyRate);
    }
    if (metrics.byStep.length > 1) {
      const best = [...metrics.byStep].sort((a, b) => b.replied - a.replied)[0];
      observations.push(`Step ${best.stepOrder} has the most replies (${best.replied}) of the ${metrics.byStep.length} steps.`);
    }

    const data = { campaign: { id: metrics.campaignId, name: metrics.name }, metrics, workspaceBenchmark, observations };
    return toolResult(data, 1, observations[0] ?? 'Analysis complete.');
  },
});

// ── research_external_content ─────────────────────────────────────────────
registerTool({
  name: 'research_external_content',
  description:
    'Would analyze an external URL (a website, a social post) for business-model/audience/hook signals. NOT YET IMPLEMENTED — no web-fetch or content-extraction provider is configured in this build. Always returns a clear not-configured result; never fetches or fabricates content. Kept registered so the tool architecture (permission, schema, activity logging) is ready for a real implementation later.',
  inputSchema: z.object({ url: z.string().url() }),
  outputSchema: resultSchema(z.object({ status: z.literal('not_configured') })),
  requiredPermission: 'research:analysis',
  category: 'research',
  readOnly: true,
  idempotent: true,
  handler: async (input) => {
    const message = `Web research is not implemented in this build. Cannot analyze ${input.url} — no fetch was attempted.`;
    return toolResult({ status: 'not_configured' as const }, 0, message);
  },
});
