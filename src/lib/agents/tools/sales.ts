/**
 * Real sales-intelligence tools for the Sales agent. No invented "AI score":
 * find_high_priority_leads sorts by the Lead.score value your own import/
 * enrichment already populates — see its description for the exact,
 * documented, deterministic ordering. Nothing here calls an LLM.
 */
import { z } from 'zod';
import { db } from '../../db';
import { registerTool } from '../registry';
import { LEAD_SELECT, leadSummarySchema, serializeLead } from './crm';
import { clampLimit, paginationInput, resultSchema, toolResult } from './shared';

const DEAD_STATUSES = ['bounced', 'unsubscribed', 'invalid'];

// ── find_high_priority_leads ────────────────────────────────────────────
registerTool({
  name: 'find_high_priority_leads',
  description:
    'Leads still worth pursuing (excludes bounced/unsubscribed/invalid), ordered by Lead.score descending — the exact value already on the record, nulls last, then newest first. This does not compute a new score; it surfaces the one your import or enrichment already set.',
  inputSchema: z.object(paginationInput),
  outputSchema: resultSchema(z.array(leadSummarySchema)),
  requiredPermission: 'sales:prioritization',
  category: 'sales',
  readOnly: true,
  idempotent: true,
  handler: async (input, ctx) => {
    const limit = clampLimit(input.limit);
    const where = { workspaceId: ctx.workspaceId, status: { notIn: DEAD_STATUSES } };
    const [leads, count] = await Promise.all([
      db.lead.findMany({
        where, select: LEAD_SELECT,
        orderBy: [{ score: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }],
        take: limit, skip: input.offset,
      }),
      db.lead.count({ where }),
    ]);
    const data = leads.map(serializeLead);
    return toolResult(data, count, `${count} active lead(s), ranked by score; returning ${data.length}.`, { limit, offset: input.offset });
  },
});

// ── identify_uncontacted_leads ───────────────────────────────────────────
registerTool({
  name: 'identify_uncontacted_leads',
  description: 'Leads with status "new" — imported but never queued into a campaign.',
  inputSchema: z.object(paginationInput),
  outputSchema: resultSchema(z.array(leadSummarySchema)),
  requiredPermission: 'sales:prioritization',
  category: 'sales',
  readOnly: true,
  idempotent: true,
  handler: async (input, ctx) => {
    const limit = clampLimit(input.limit);
    const where = { workspaceId: ctx.workspaceId, status: 'new' };
    const [leads, count] = await Promise.all([
      db.lead.findMany({ where, select: LEAD_SELECT, orderBy: { createdAt: 'desc' }, take: limit, skip: input.offset }),
      db.lead.count({ where }),
    ]);
    const data = leads.map(serializeLead);
    return toolResult(data, count, `${count} uncontacted lead(s); returning ${data.length}.`, { limit, offset: input.offset });
  },
});

// ── identify_replied_leads ───────────────────────────────────────────────
registerTool({
  name: 'identify_replied_leads',
  description:
    'Leads with status "replied". In this build, replies are only detected on WhatsApp (the inbound webhook) — there is no email reply/inbox tracking yet, so an email-only lead will never appear here even if they actually replied.',
  inputSchema: z.object(paginationInput),
  outputSchema: resultSchema(z.array(leadSummarySchema)),
  requiredPermission: 'sales:prioritization',
  category: 'sales',
  readOnly: true,
  idempotent: true,
  handler: async (input, ctx) => {
    const limit = clampLimit(input.limit);
    const where = { workspaceId: ctx.workspaceId, status: 'replied' };
    const [leads, count] = await Promise.all([
      db.lead.findMany({ where, select: LEAD_SELECT, orderBy: { createdAt: 'desc' }, take: limit, skip: input.offset }),
      db.lead.count({ where }),
    ]);
    const data = leads.map(serializeLead);
    return toolResult(data, count, `${count} replied lead(s) (WhatsApp only in this build); returning ${data.length}.`, { limit, offset: input.offset });
  },
});

// ── identify_recently_active_leads ───────────────────────────────────────
registerTool({
  name: 'identify_recently_active_leads',
  description: 'Leads with an email open/click or a reply recorded within the given lookback window (default 7 days, max 90).',
  inputSchema: z.object({ lookbackDays: z.number().int().min(1).max(90).default(7), ...paginationInput }),
  outputSchema: resultSchema(z.array(leadSummarySchema)),
  requiredPermission: 'sales:prioritization',
  category: 'sales',
  readOnly: true,
  idempotent: true,
  handler: async (input, ctx) => {
    const limit = clampLimit(input.limit);
    const since = new Date(Date.now() - input.lookbackDays * 86_400_000);
    const activeLeadIds = await db.message.findMany({
      where: {
        workspaceId: ctx.workspaceId,
        OR: [{ openedAt: { gte: since } }, { clickedAt: { gte: since } }, { repliedAt: { gte: since } }],
      },
      select: { leadId: true },
      distinct: ['leadId'],
    });
    const ids = activeLeadIds.map((m) => m.leadId);
    if (ids.length === 0) return toolResult([], 0, `No leads had opens, clicks or replies in the last ${input.lookbackDays} day(s).`, { limit, offset: input.offset });

    const where = { workspaceId: ctx.workspaceId, id: { in: ids } };
    const [leads, count] = await Promise.all([
      db.lead.findMany({ where, select: LEAD_SELECT, orderBy: { createdAt: 'desc' }, take: limit, skip: input.offset }),
      db.lead.count({ where }),
    ]);
    const data = leads.map(serializeLead);
    return toolResult(data, count, `${count} lead(s) active in the last ${input.lookbackDays} day(s); returning ${data.length}.`, { limit, offset: input.offset });
  },
});

// ── summarize_lead_history ───────────────────────────────────────────────
const leadHistorySchema = z.object({
  lead: leadSummarySchema,
  totalMessages: z.number(),
  byChannel: z.record(z.string(), z.number()),
  opened: z.number(),
  clicked: z.number(),
  replied: z.number(),
  lastActivityAt: z.string().nullable(),
});

registerTool({
  name: 'summarize_lead_history',
  description: 'A structured rollup of one lead\'s message history: totals by channel, real open/click/reply counts, and the most recent activity timestamp. Facts only — no generated narrative.',
  inputSchema: z.object({ leadId: z.string().min(1) }),
  outputSchema: resultSchema(leadHistorySchema.nullable()),
  requiredPermission: 'sales:prioritization',
  category: 'sales',
  readOnly: true,
  idempotent: true,
  handler: async (input, ctx) => {
    const lead = await db.lead.findFirst({ where: { id: input.leadId, workspaceId: ctx.workspaceId }, select: LEAD_SELECT });
    if (!lead) return toolResult(null, 0, 'No lead found with that id in this workspace.');

    const messages = await db.message.findMany({
      where: { leadId: lead.id, workspaceId: ctx.workspaceId },
      select: { channel: true, openedAt: true, clickedAt: true, repliedAt: true, sentAt: true, createdAt: true },
    });

    const byChannel: Record<string, number> = {};
    for (const m of messages) byChannel[m.channel] = (byChannel[m.channel] ?? 0) + 1;

    const timestamps = messages.flatMap((m) => [m.openedAt, m.clickedAt, m.repliedAt, m.sentAt].filter((d): d is Date => d !== null));
    const lastActivityAt = timestamps.length ? new Date(Math.max(...timestamps.map((d) => d.getTime()))).toISOString() : null;

    const data = {
      lead: serializeLead(lead),
      totalMessages: messages.length,
      byChannel,
      opened: messages.filter((m) => m.openedAt !== null).length,
      clicked: messages.filter((m) => m.clickedAt !== null).length,
      replied: messages.filter((m) => m.repliedAt !== null).length,
      lastActivityAt,
    };
    return toolResult(data, 1, `${data.totalMessages} message(s) sent; last activity ${lastActivityAt ?? 'never'}.`);
  },
});
