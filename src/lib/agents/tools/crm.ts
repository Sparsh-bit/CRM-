/**
 * Real, read-only CRM tools over the existing Lead/LeadList/Message schema.
 * No Contact/Company model exists in this schema — a "company" here is a
 * value grouping of Lead.company, not a separate entity; get_contact/
 * search_contacts were deliberately not added since Lead already IS the
 * contact record (see docs/agent-tools.md for the full reasoning).
 *
 * Every handler filters by ctx.workspaceId — there is no other way into
 * this data, from this tool or any other layer.
 */
import { z } from 'zod';
import { db } from '../../db';
import { registerTool } from '../registry';
import { clampLimit, paginationInput, resultSchema, toolResult } from './shared';

export const leadSummarySchema = z.object({
  id: z.string(),
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  fullName: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  company: z.string().nullable(),
  title: z.string().nullable(),
  industry: z.string().nullable(),
  city: z.string().nullable(),
  country: z.string().nullable(),
  tier: z.string().nullable(),
  score: z.number().nullable(),
  tags: z.array(z.string()),
  status: z.string(),
  listId: z.string(),
  createdAt: z.string(),
});

export const LEAD_SELECT = {
  id: true, firstName: true, lastName: true, fullName: true, email: true, phone: true,
  company: true, title: true, industry: true, city: true, country: true, tier: true,
  score: true, tags: true, status: true, listId: true, createdAt: true,
} as const;

export function serializeLead(l: {
  id: string; firstName: string | null; lastName: string | null; fullName: string | null;
  email: string | null; phone: string | null; company: string | null; title: string | null;
  industry: string | null; city: string | null; country: string | null; tier: string | null;
  score: number | null; tags: string[]; status: string; listId: string; createdAt: Date;
}) {
  return { ...l, createdAt: l.createdAt.toISOString() };
}

// ── get_lead ─────────────────────────────────────────────────────────────
registerTool({
  name: 'get_lead',
  description: 'Fetch one lead by id, with its canonical fields, tags, score, and status.',
  inputSchema: z.object({ leadId: z.string().min(1) }),
  outputSchema: resultSchema(leadSummarySchema.nullable()),
  requiredPermission: 'crm:read',
  category: 'crm',
  readOnly: true,
  idempotent: true,
  handler: async (input, ctx) => {
    const lead = await db.lead.findFirst({ where: { id: input.leadId, workspaceId: ctx.workspaceId }, select: LEAD_SELECT });
    return toolResult(lead ? serializeLead(lead) : null, lead ? 1 : 0, lead ? `Found lead ${lead.id}.` : 'No lead found with that id in this workspace.');
  },
});

// ── list_leads ───────────────────────────────────────────────────────────
const listLeadsInput = z.object({
  status: z.string().optional(),
  listId: z.string().optional(),
  tag: z.string().optional(),
  minScore: z.number().int().optional(),
  createdAfter: z.string().datetime().optional(),
  createdBefore: z.string().datetime().optional(),
  ...paginationInput,
});

async function queryLeads(ctx: { workspaceId: string }, filters: {
  status?: string; listId?: string; tag?: string; minScore?: number; createdAfter?: string; createdBefore?: string;
  search?: string;
}, limit: number, offset: number) {
  const where = {
    workspaceId: ctx.workspaceId,
    ...(filters.status ? { status: filters.status } : {}),
    ...(filters.listId ? { listId: filters.listId } : {}),
    ...(filters.tag ? { tags: { has: filters.tag } } : {}),
    ...(filters.minScore !== undefined ? { score: { gte: filters.minScore } } : {}),
    ...(filters.createdAfter || filters.createdBefore ? {
      createdAt: {
        ...(filters.createdAfter ? { gte: new Date(filters.createdAfter) } : {}),
        ...(filters.createdBefore ? { lte: new Date(filters.createdBefore) } : {}),
      },
    } : {}),
    ...(filters.search ? {
      OR: [
        { fullName: { contains: filters.search, mode: 'insensitive' as const } },
        { email: { contains: filters.search, mode: 'insensitive' as const } },
        { company: { contains: filters.search, mode: 'insensitive' as const } },
        { title: { contains: filters.search, mode: 'insensitive' as const } },
      ],
    } : {}),
  };
  const [leads, count] = await Promise.all([
    db.lead.findMany({ where, select: LEAD_SELECT, orderBy: { createdAt: 'desc' }, take: limit, skip: offset }),
    db.lead.count({ where }),
  ]);
  return { leads: leads.map(serializeLead), count };
}

registerTool({
  name: 'list_leads',
  description: 'List leads in this workspace with optional filters (status, source list, tag, minimum score, created-date range) and pagination.',
  inputSchema: listLeadsInput,
  outputSchema: resultSchema(z.array(leadSummarySchema)),
  requiredPermission: 'crm:read',
  category: 'crm',
  readOnly: true,
  idempotent: true,
  handler: async (input, ctx) => {
    const limit = clampLimit(input.limit);
    const { leads, count } = await queryLeads(ctx, input, limit, input.offset);
    return toolResult(leads, count, `${count} lead(s) match these filters; returning ${leads.length}.`, { limit, offset: input.offset });
  },
});

// ── search_leads ─────────────────────────────────────────────────────────
registerTool({
  name: 'search_leads',
  description: 'Free-text search across a lead\'s name, email, company and title (case-insensitive substring match), with the same filters as list_leads.',
  inputSchema: listLeadsInput.extend({ query: z.string().min(1).max(200) }),
  outputSchema: resultSchema(z.array(leadSummarySchema)),
  requiredPermission: 'crm:read',
  category: 'crm',
  readOnly: true,
  idempotent: true,
  handler: async (input, ctx) => {
    const limit = clampLimit(input.limit);
    const { leads, count } = await queryLeads(ctx, { ...input, search: input.query }, limit, input.offset);
    return toolResult(leads, count, `${count} lead(s) match "${input.query}"; returning ${leads.length}.`, { limit, offset: input.offset });
  },
});

// ── get_lead_activity ────────────────────────────────────────────────────
const activityItemSchema = z.object({
  messageId: z.string(),
  channel: z.string(),
  campaignId: z.string().nullable(),
  status: z.string(),
  sentAt: z.string().nullable(),
  openedAt: z.string().nullable(),
  clickedAt: z.string().nullable(),
  repliedAt: z.string().nullable(),
  events: z.array(z.object({ type: z.string(), createdAt: z.string() })),
});

registerTool({
  name: 'get_lead_activity',
  description: 'Every message sent to a lead and the real tracking events recorded against it (opens/clicks are email-only; replies are currently only detected on WhatsApp — see docs/agent-tools.md).',
  inputSchema: z.object({ leadId: z.string().min(1), ...paginationInput }),
  outputSchema: resultSchema(z.array(activityItemSchema)),
  requiredPermission: 'crm:read',
  category: 'crm',
  readOnly: true,
  idempotent: true,
  handler: async (input, ctx) => {
    const lead = await db.lead.findFirst({ where: { id: input.leadId, workspaceId: ctx.workspaceId }, select: { id: true } });
    if (!lead) return toolResult([], 0, 'No lead found with that id in this workspace.');

    const limit = clampLimit(input.limit);
    const [messages, count] = await Promise.all([
      db.message.findMany({
        where: { leadId: lead.id, workspaceId: ctx.workspaceId },
        orderBy: { createdAt: 'desc' }, take: limit, skip: input.offset,
        include: { events: { orderBy: { createdAt: 'asc' }, select: { type: true, createdAt: true } } },
      }),
      db.message.count({ where: { leadId: lead.id, workspaceId: ctx.workspaceId } }),
    ]);

    const data = messages.map((m) => ({
      messageId: m.id, channel: m.channel, campaignId: m.campaignId, status: m.status,
      sentAt: m.sentAt?.toISOString() ?? null, openedAt: m.openedAt?.toISOString() ?? null,
      clickedAt: m.clickedAt?.toISOString() ?? null, repliedAt: m.repliedAt?.toISOString() ?? null,
      events: m.events.map((e) => ({ type: e.type, createdAt: e.createdAt.toISOString() })),
    }));
    return toolResult(data, count, `${count} message(s) sent to this lead; returning ${data.length}.`, { limit, offset: input.offset });
  },
});

// ── list_companies / get_company (derived from Lead.company — no Company model exists) ──
const companySummarySchema = z.object({ company: z.string(), leadCount: z.number() });

registerTool({
  name: 'list_companies',
  description: 'Distinct companies seen across this workspace\'s leads, with a lead count each. There is no separate Company record — this groups Lead.company.',
  inputSchema: z.object(paginationInput),
  outputSchema: resultSchema(z.array(companySummarySchema)),
  requiredPermission: 'crm:companies',
  category: 'crm',
  readOnly: true,
  idempotent: true,
  handler: async (input, ctx) => {
    const limit = clampLimit(input.limit);
    const grouped = await db.lead.groupBy({
      by: ['company'],
      where: { workspaceId: ctx.workspaceId, company: { not: null } },
      _count: { _all: true },
      orderBy: { _count: { company: 'desc' } },
    });
    const total = grouped.length;
    const page = grouped.slice(input.offset, input.offset + limit)
      .map((g) => ({ company: g.company as string, leadCount: g._count._all }));
    return toolResult(page, total, `${total} distinct compan(y/ies); returning ${page.length}.`, { limit, offset: input.offset });
  },
});

registerTool({
  name: 'get_company',
  description: 'Aggregated view of one company: how many leads, which industries/cities/statuses are represented, and the leads themselves (paginated). Derived from Lead.company, not a separate record.',
  inputSchema: z.object({ company: z.string().min(1), ...paginationInput }),
  outputSchema: resultSchema(z.object({
    company: z.string(),
    leadCount: z.number(),
    industries: z.array(z.string()),
    cities: z.array(z.string()),
    statusBreakdown: z.record(z.string(), z.number()),
    leads: z.array(leadSummarySchema),
  }).nullable()),
  requiredPermission: 'crm:companies',
  category: 'crm',
  readOnly: true,
  idempotent: true,
  handler: async (input, ctx) => {
    const limit = clampLimit(input.limit);
    const where = { workspaceId: ctx.workspaceId, company: input.company };
    const [leads, count] = await Promise.all([
      db.lead.findMany({ where, select: LEAD_SELECT, orderBy: { createdAt: 'desc' }, take: limit, skip: input.offset }),
      db.lead.count({ where }),
    ]);
    if (count === 0) return toolResult(null, 0, `No leads found for company "${input.company}" in this workspace.`);

    const all = await db.lead.findMany({ where, select: { industry: true, city: true, status: true } });
    const industries = [...new Set(all.map((l) => l.industry).filter((v): v is string => !!v))];
    const cities = [...new Set(all.map((l) => l.city).filter((v): v is string => !!v))];
    const statusBreakdown: Record<string, number> = {};
    for (const l of all) statusBreakdown[l.status] = (statusBreakdown[l.status] ?? 0) + 1;

    const data = { company: input.company, leadCount: count, industries, cities, statusBreakdown, leads: leads.map(serializeLead) };
    return toolResult(data, count, `${count} lead(s) at "${input.company}"; returning ${leads.length}.`, { limit, offset: input.offset });
  },
});
