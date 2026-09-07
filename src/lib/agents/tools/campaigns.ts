/**
 * Real, read-only campaign analytics over the existing Campaign/Message/Event
 * schema. Every rate/count here is computed from rows this app actually
 * writes — see the `notTracked` field on metrics results for what this build
 * does not (yet) record, rather than silently reporting zero for it.
 */
import { z } from 'zod';
import { db } from '../../db';
import { registerTool } from '../registry';
import { clampLimit, paginationInput, resultSchema, toolResult } from './shared';

const campaignSchema = z.object({
  id: z.string(), name: z.string(), channel: z.string(), status: z.string(),
  aiEnabled: z.boolean(), listId: z.string().nullable(), stepCount: z.number(),
  scheduledAt: z.string().nullable(), startedAt: z.string().nullable(), finishedAt: z.string().nullable(),
  createdAt: z.string(),
});

async function serializeCampaign(c: {
  id: string; name: string; channel: string; status: string; aiEnabled: boolean; listId: string | null;
  scheduledAt: Date | null; startedAt: Date | null; finishedAt: Date | null; createdAt: Date;
}) {
  const stepCount = await db.campaignStep.count({ where: { campaignId: c.id } });
  return {
    id: c.id, name: c.name, channel: c.channel, status: c.status, aiEnabled: c.aiEnabled, listId: c.listId, stepCount,
    scheduledAt: c.scheduledAt?.toISOString() ?? null, startedAt: c.startedAt?.toISOString() ?? null,
    finishedAt: c.finishedAt?.toISOString() ?? null, createdAt: c.createdAt.toISOString(),
  };
}

// ── get_campaign ─────────────────────────────────────────────────────────
registerTool({
  name: 'get_campaign',
  description: 'Fetch one campaign by id: its channel, status, AI-writer configuration, and step count.',
  inputSchema: z.object({ campaignId: z.string().min(1) }),
  outputSchema: resultSchema(campaignSchema.nullable()),
  requiredPermission: 'campaign:read',
  category: 'campaign',
  readOnly: true,
  idempotent: true,
  handler: async (input, ctx) => {
    const c = await db.campaign.findFirst({ where: { id: input.campaignId, workspaceId: ctx.workspaceId } });
    if (!c) return toolResult(null, 0, 'No campaign found with that id in this workspace.');
    return toolResult(await serializeCampaign(c), 1, `Found campaign "${c.name}".`);
  },
});

// ── list_campaigns ───────────────────────────────────────────────────────
registerTool({
  name: 'list_campaigns',
  description: 'List campaigns in this workspace, optionally filtered by status or channel.',
  inputSchema: z.object({ status: z.string().optional(), channel: z.string().optional(), ...paginationInput }),
  outputSchema: resultSchema(z.array(campaignSchema)),
  requiredPermission: 'campaign:read',
  category: 'campaign',
  readOnly: true,
  idempotent: true,
  handler: async (input, ctx) => {
    const limit = clampLimit(input.limit);
    const where = {
      workspaceId: ctx.workspaceId,
      ...(input.status ? { status: input.status } : {}),
      ...(input.channel ? { channel: input.channel } : {}),
    };
    const [campaigns, count] = await Promise.all([
      db.campaign.findMany({ where, orderBy: { createdAt: 'desc' }, take: limit, skip: input.offset }),
      db.campaign.count({ where }),
    ]);
    const data = await Promise.all(campaigns.map(serializeCampaign));
    return toolResult(data, count, `${count} campaign(s) match these filters; returning ${data.length}.`, { limit, offset: input.offset });
  },
});

// ── metrics (shared by get_campaign_metrics and compare_campaigns) ────────
const NOT_TRACKED = [
  'delivered — no provider delivery-confirmation webhook is wired up in this build',
  'bounced (async) — no bounce-webhook processing exists; "failed" below is the closest real signal (an SMTP-level rejection at send time)',
  'complaint — no spam-complaint webhook exists',
];

const metricsSchema = z.object({
  campaignId: z.string(),
  name: z.string(),
  totalMessages: z.number(),
  sent: z.number(),
  failed: z.number(),
  skipped: z.number(),
  opened: z.number(),
  clicked: z.number(),
  replied: z.number(),
  unsubscribed: z.number(),
  openRate: z.number().nullable(),
  clickRate: z.number().nullable(),
  replyRate: z.number().nullable(),
  byStep: z.array(z.object({ stepOrder: z.number(), sent: z.number(), opened: z.number(), clicked: z.number(), replied: z.number() })),
  notTracked: z.array(z.string()),
});

async function computeCampaignMetrics(workspaceId: string, campaignId: string) {
  const campaign = await db.campaign.findFirst({ where: { id: campaignId, workspaceId }, select: { id: true, name: true } });
  if (!campaign) return null;

  const messages = await db.message.findMany({
    where: { campaignId: campaign.id, workspaceId },
    select: { status: true, sentAt: true, openedAt: true, clickedAt: true, repliedAt: true, stepOrder: true },
  });
  const unsubscribed = await db.event.count({ where: { type: 'unsubscribe', message: { campaignId: campaign.id, workspaceId } } });

  const sent = messages.filter((m) => m.sentAt !== null).length;
  const failed = messages.filter((m) => m.status === 'failed').length;
  const skipped = messages.filter((m) => m.status === 'skipped').length;
  const opened = messages.filter((m) => m.openedAt !== null).length;
  const clicked = messages.filter((m) => m.clickedAt !== null).length;
  const replied = messages.filter((m) => m.repliedAt !== null).length;

  const stepOrders = [...new Set(messages.map((m) => m.stepOrder))].sort((a, b) => a - b);
  const byStep = stepOrders.map((stepOrder) => {
    const stepMessages = messages.filter((m) => m.stepOrder === stepOrder);
    return {
      stepOrder,
      sent: stepMessages.filter((m) => m.sentAt !== null).length,
      opened: stepMessages.filter((m) => m.openedAt !== null).length,
      clicked: stepMessages.filter((m) => m.clickedAt !== null).length,
      replied: stepMessages.filter((m) => m.repliedAt !== null).length,
    };
  });

  const rate = (n: number) => (sent > 0 ? Math.round((n / sent) * 1000) / 1000 : null);

  return {
    campaignId: campaign.id, name: campaign.name, totalMessages: messages.length,
    sent, failed, skipped, opened, clicked, replied, unsubscribed,
    openRate: rate(opened), clickRate: rate(clicked), replyRate: rate(replied),
    byStep, notTracked: NOT_TRACKED,
  };
}

registerTool({
  name: 'get_campaign_metrics',
  description: 'Real send/open/click/reply/unsubscribe counts and rates for one campaign, computed from actual Message/Event rows, with a per-step breakdown. Explicitly lists what this build does not track rather than guessing.',
  inputSchema: z.object({ campaignId: z.string().min(1) }),
  outputSchema: resultSchema(metricsSchema.nullable()),
  requiredPermission: 'campaign:analytics',
  category: 'campaign',
  readOnly: true,
  idempotent: true,
  handler: async (input, ctx) => {
    const metrics = await computeCampaignMetrics(ctx.workspaceId, input.campaignId);
    if (!metrics) return toolResult(null, 0, 'No campaign found with that id in this workspace.');
    return toolResult(metrics, 1, `${metrics.sent} sent, ${metrics.replied} replied, ${metrics.failed} failed.`);
  },
});

// ── compare_campaigns ────────────────────────────────────────────────────
registerTool({
  name: 'compare_campaigns',
  description: 'The same metrics as get_campaign_metrics, for 2-5 campaigns at once, side by side.',
  inputSchema: z.object({ campaignIds: z.array(z.string().min(1)).min(2).max(5) }),
  outputSchema: resultSchema(z.array(metricsSchema)),
  requiredPermission: 'campaign:analytics',
  category: 'campaign',
  readOnly: true,
  idempotent: true,
  handler: async (input, ctx) => {
    const results = await Promise.all(input.campaignIds.map((id) => computeCampaignMetrics(ctx.workspaceId, id)));
    const found = results.filter((r): r is NonNullable<typeof r> => r !== null);
    const missing = input.campaignIds.length - found.length;
    return toolResult(found, found.length,
      `Compared ${found.length} campaign(s)${missing ? ` (${missing} id(s) not found in this workspace)` : ''}.`);
  },
});

// ── get_campaign_activity ────────────────────────────────────────────────
const campaignActivityItemSchema = z.object({
  messageId: z.string(), leadId: z.string(), toAddress: z.string(), status: z.string(),
  stepOrder: z.number(), sentAt: z.string().nullable(), createdAt: z.string(),
  events: z.array(z.object({ type: z.string(), createdAt: z.string() })),
});

registerTool({
  name: 'get_campaign_activity',
  description: 'Recent message-level activity for a campaign — who was messaged, when, and what tracking events fired — most recent first, paginated.',
  inputSchema: z.object({ campaignId: z.string().min(1), ...paginationInput }),
  outputSchema: resultSchema(z.array(campaignActivityItemSchema)),
  requiredPermission: 'campaign:read',
  category: 'campaign',
  readOnly: true,
  idempotent: true,
  handler: async (input, ctx) => {
    const campaign = await db.campaign.findFirst({ where: { id: input.campaignId, workspaceId: ctx.workspaceId }, select: { id: true } });
    if (!campaign) return toolResult([], 0, 'No campaign found with that id in this workspace.');

    const limit = clampLimit(input.limit);
    const where = { campaignId: campaign.id, workspaceId: ctx.workspaceId };
    const [messages, count] = await Promise.all([
      db.message.findMany({
        where, orderBy: { createdAt: 'desc' }, take: limit, skip: input.offset,
        include: { events: { orderBy: { createdAt: 'asc' }, select: { type: true, createdAt: true } } },
      }),
      db.message.count({ where }),
    ]);

    const data = messages.map((m) => ({
      messageId: m.id, leadId: m.leadId, toAddress: m.toAddress, status: m.status, stepOrder: m.stepOrder,
      sentAt: m.sentAt?.toISOString() ?? null, createdAt: m.createdAt.toISOString(),
      events: m.events.map((e) => ({ type: e.type, createdAt: e.createdAt.toISOString() })),
    }));
    return toolResult(data, count, `${count} message(s) for this campaign; returning ${data.length}.`, { limit, offset: input.offset });
  },
});

export { computeCampaignMetrics };
