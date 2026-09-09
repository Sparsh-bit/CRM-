import { db } from './db';
import { enqueue } from './queue';
import { render } from './template';
import { nanoid } from 'nanoid';
import type { Lead, Campaign, CampaignStep, Prisma } from '@/generated/prisma/client';

export function leadMergeContext(lead: Lead, workspace: { senderName: string | null; senderCompany: string | null }) {
  return {
    first_name: lead.firstName ?? '',
    last_name: lead.lastName ?? '',
    full_name: lead.fullName ?? '',
    name: lead.fullName ?? lead.firstName ?? '',
    email: lead.email ?? '',
    phone: lead.phone ?? '',
    company: lead.company ?? '',
    title: lead.title ?? '',
    industry: lead.industry ?? '',
    city: lead.city ?? '',
    country: lead.country ?? '',
    website: lead.website ?? '',
    tier: lead.tier ?? '',
    sender_name: workspace.senderName ?? '',
    sender_company: workspace.senderCompany ?? '',
    ...(lead.custom as Record<string, unknown>),
  };
}

export type PreflightIssue = {
  leadId: string; company: string | null; severity: 'block' | 'warn'; message: string;
};

/**
 * A lead list may only be attached to a campaign in the same workspace.
 * CampaignStep/Draft rows have no workspaceId of their own — every write to
 * either MUST go through updateCampaignStep/updateCampaignDraft below,
 * never a raw db.campaignStep.update/db.draft.update by id, or a caller who
 * already verified a campaignId belongs to their workspace can still be
 * tricked into writing a sibling's stepId/draftId (the id alone doesn't
 * prove it belongs to THAT campaign).
 */
export async function assertListOwnership(workspaceId: string, listId: string): Promise<void> {
  const list = await db.leadList.findFirst({ where: { id: listId, workspaceId } });
  if (!list) throw new Error('That lead list was not found in this workspace.');
}

/** Update one step's content. campaignId must already be verified as belonging to the caller's workspace — this additionally verifies stepId belongs to THAT campaign, not just that campaignId is legitimate. */
export async function updateCampaignStep(
  campaignId: string,
  stepId: string,
  data: { subject: string | null; body: string; delayDays: number; condition: string },
): Promise<void> {
  const updated = await db.campaignStep.updateMany({ where: { id: stepId, campaignId }, data });
  if (updated.count === 0) throw new Error('Step not found on this campaign.');
}

/** Update one draft's content and mark it approved. Same campaign-ownership guard as updateCampaignStep. */
export async function updateCampaignDraft(
  campaignId: string,
  draftId: string,
  data: { subject: string | null; body: string },
): Promise<void> {
  const updated = await db.draft.updateMany({
    where: { id: draftId, campaignId },
    data: { ...data, approved: true, edited: true },
  });
  if (updated.count === 0) throw new Error('Draft not found on this campaign.');
}

/**
 * Nothing sends until this passes. Catches the classic disasters:
 * "Hi ," / missing merge data / suppressed / invalid address / no channel.
 */
export async function preflight(campaignId: string): Promise<{
  ok: boolean; total: number; sendable: number; issues: PreflightIssue[];
}> {
  const campaign = await db.campaign.findUniqueOrThrow({
    where: { id: campaignId },
    include: { steps: { orderBy: { order: 'asc' } }, workspace: true },
  });
  if (!campaign.listId) return { ok: false, total: 0, sendable: 0, issues: [{ leadId: '', company: null, severity: 'block', message: 'No lead list attached.' }] };

  const leads = await db.lead.findMany({ where: { listId: campaign.listId } });
  const suppressions = new Set(
    (await db.suppression.findMany({ where: { workspaceId: campaign.workspaceId } })).map((s) => s.value),
  );
  const drafts = campaign.aiEnabled
    ? await db.draft.findMany({ where: { campaignId }, select: { leadId: true, approved: true, body: true } })
    : [];
  const draftByLead = new Map(drafts.map((d) => [d.leadId, d]));

  const issues: PreflightIssue[] = [];
  let sendable = 0;

  for (const lead of leads) {
    // 'both' has only ever meant email+whatsapp — sms stays a standalone
    // channel value so this doesn't change what an existing "both" campaign does.
    const wantsEmail = campaign.channel === 'email' || campaign.channel === 'both';
    const wantsWa = campaign.channel === 'whatsapp' || campaign.channel === 'both';
    const wantsSms = campaign.channel === 'sms';
    const wantsAnyPhoneChannel = wantsWa || wantsSms;
    let leadOk = true;

    if (wantsEmail && (!lead.email || !lead.emailValid)) {
      issues.push({ leadId: lead.id, company: lead.company, severity: wantsAnyPhoneChannel ? 'warn' : 'block', message: 'No valid email address.' });
      if (!wantsAnyPhoneChannel) leadOk = false;
    }
    if (wantsAnyPhoneChannel && !lead.phone) {
      issues.push({ leadId: lead.id, company: lead.company, severity: wantsEmail ? 'warn' : 'block', message: 'No usable phone number.' });
      if (!wantsEmail) leadOk = false;
    }
    if ((lead.email && suppressions.has(lead.email)) || (lead.phone && suppressions.has(lead.phone))) {
      issues.push({ leadId: lead.id, company: lead.company, severity: 'block', message: 'On the suppression list.' });
      leadOk = false;
    }
    if (lead.status === 'unsubscribed' || lead.status === 'bounced') {
      issues.push({ leadId: lead.id, company: lead.company, severity: 'block', message: `Lead status is ${lead.status}.` });
      leadOk = false;
    }

    if (campaign.aiEnabled) {
      const d = draftByLead.get(lead.id);
      if (!d || !d.body.trim()) {
        issues.push({ leadId: lead.id, company: lead.company, severity: 'block', message: 'AI draft not generated yet.' });
        leadOk = false;
      }
    } else {
      const ctx = leadMergeContext(lead, campaign.workspace);
      for (const step of campaign.steps) {
        const r = render(`${step.subject ?? ''}\n${step.body}`, ctx, lead.id);
        if (r.missing.length) {
          issues.push({
            leadId: lead.id, company: lead.company, severity: 'block',
            message: `Step ${step.order}: unresolved merge tags — ${r.missing.join(', ')}. Add a fallback, e.g. {{${r.missing[0]} | fallback: "there"}}.`,
          });
          leadOk = false;
        }
      }
    }

    if (leadOk) sendable++;
  }

  return { ok: issues.every((i) => i.severity !== 'block') && sendable > 0, total: leads.length, sendable, issues };
}

/**
 * Materialise queued Messages for step 1. Follow-ups are queued on send.
 *
 * Batched, not per-lead: the old version did up to 3 sequential DB round
 * trips (findFirst, create, lead.update) PER LEAD PER CHANNEL inside a plain
 * loop, all awaited inline in the Server Action that launches a campaign
 * (src/app/campaigns/[id]/page.tsx's `launch`) — for a list in the
 * thousands (this app's own quotas allow up to 500k leads on the pro plan,
 * src/lib/usage/plans.ts), that's thousands of sequential round trips
 * blocking one HTTP request, real request-timeout risk. The per-lead
 * decision logic (suppression, unsubscribed/bounced, missing draft, dedup)
 * is unchanged — it now runs in memory against one upfront existing-message
 * fetch, and every write is one batched call instead of N.
 */
export async function buildQueue(campaignId: string): Promise<{ queued: number }> {
  const campaign = await db.campaign.findUniqueOrThrow({
    where: { id: campaignId },
    include: { steps: { orderBy: { order: 'asc' } }, workspace: true },
  });
  if (!campaign.listId) throw new Error('Campaign has no list');

  const leads = await db.lead.findMany({ where: { listId: campaign.listId } });
  const suppressed = new Set(
    (await db.suppression.findMany({ where: { workspaceId: campaign.workspaceId } })).map((s) => s.value),
  );
  const step1 = campaign.steps[0];
  if (!step1) throw new Error('Campaign has no steps');

  const drafts = new Map(
    (await db.draft.findMany({ where: { campaignId, stepOrder: 1 } })).map((d) => [d.leadId + ':' + d.channel, d]),
  );

  // One fetch for every message that already exists for step 1 of this
  // campaign — replaces the per-lead-per-channel findFirst. This one query is
  // what makes re-running buildQueue() safe (see campaign-idor/sender tests):
  // a lead+channel pair already in this set is never re-queued.
  const existing = new Set(
    (await db.message.findMany({ where: { campaignId, stepOrder: 1 }, select: { leadId: true, channel: true } }))
      .map((m) => m.leadId + ':' + m.channel),
  );

  const toCreate: Prisma.MessageCreateManyInput[] = [];
  const queuedLeadIds = new Set<string>();

  for (const lead of leads) {
    if (lead.status === 'unsubscribed' || lead.status === 'bounced') continue;
    if (lead.email && suppressed.has(lead.email)) continue;
    if (lead.phone && suppressed.has(lead.phone)) continue;

    // 'both' still means exactly email+whatsapp, unchanged — 'sms' is its own standalone channel value.
    const channels: ('email' | 'whatsapp' | 'sms')[] =
      campaign.channel === 'both' ? ['email', 'whatsapp'] : [campaign.channel as 'email' | 'whatsapp' | 'sms'];

    for (const channel of channels) {
      const to = channel === 'email' ? lead.email : lead.phone;
      if (!to) continue;
      if (channel === 'email' && !lead.emailValid) continue;
      if (existing.has(lead.id + ':' + channel)) continue;

      const ctx = leadMergeContext(lead, campaign.workspace);
      let subject = '', body = '';

      if (campaign.aiEnabled) {
        const d = drafts.get(lead.id + ':' + channel) ?? drafts.get(lead.id + ':email');
        if (!d) continue;
        subject = d.subject ?? '';
        body = d.body;
      } else {
        subject = render(step1.subject ?? '', ctx, lead.id).text;
        body = render(step1.body, ctx, lead.id).text;
      }

      toCreate.push({
        workspaceId: campaign.workspaceId, campaignId, leadId: lead.id,
        stepOrder: 1, channel, toAddress: to, subject: channel === 'email' ? subject : null,
        body, trackingId: nanoid(22), status: 'queued', scheduledFor: new Date(),
      });
      queuedLeadIds.add(lead.id);
    }
  }

  if (toCreate.length) {
    await db.message.createMany({ data: toCreate });
    await db.lead.updateMany({ where: { id: { in: [...queuedLeadIds] } }, data: { status: 'queued' } });
  }

  await enqueue(campaign.workspaceId, 'send_message', { campaignId });
  return { queued: toCreate.length };
}

/** Queue the next step for a lead after a send, honouring delayDays + condition. */
export async function scheduleFollowUp(campaign: Campaign & { steps: CampaignStep[] }, lead: Lead, afterOrder: number) {
  const next = campaign.steps.find((s) => s.order === afterOrder + 1);
  if (!next) return;
  const to = next.channel === 'email' ? lead.email : lead.phone;
  if (!to) return;

  const runAt = new Date(Date.now() + next.delayDays * 86_400_000);
  const ctx = leadMergeContext(lead, { senderName: null, senderCompany: null });
  await db.message.create({
    data: {
      workspaceId: campaign.workspaceId, campaignId: campaign.id, leadId: lead.id,
      stepOrder: next.order, channel: next.channel, toAddress: to,
      subject: next.channel === 'email' ? render(next.subject ?? '', ctx, lead.id).text : null,
      body: render(next.body, ctx, lead.id).text,
      trackingId: nanoid(22), status: 'queued', scheduledFor: runAt,
    },
  });
}
