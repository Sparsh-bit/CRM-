import { db } from './db';
import { enqueue } from './queue';
import { render } from './template';
import { nanoid } from 'nanoid';
import type { Lead, Campaign, CampaignStep } from '@prisma/client';

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
    const wantsEmail = campaign.channel === 'email' || campaign.channel === 'both';
    const wantsWa = campaign.channel === 'whatsapp' || campaign.channel === 'both';
    let leadOk = true;

    if (wantsEmail && (!lead.email || !lead.emailValid)) {
      issues.push({ leadId: lead.id, company: lead.company, severity: wantsWa ? 'warn' : 'block', message: 'No valid email address.' });
      if (!wantsWa) leadOk = false;
    }
    if (wantsWa && !lead.phone) {
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

/** Materialise queued Messages for step 1. Follow-ups are queued on send. */
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

  let queued = 0;
  for (const lead of leads) {
    if (lead.status === 'unsubscribed' || lead.status === 'bounced') continue;
    if (lead.email && suppressed.has(lead.email)) continue;
    if (lead.phone && suppressed.has(lead.phone)) continue;

    const channels: ('email' | 'whatsapp')[] =
      campaign.channel === 'both' ? ['email', 'whatsapp'] : [campaign.channel as 'email' | 'whatsapp'];

    for (const channel of channels) {
      const to = channel === 'email' ? lead.email : lead.phone;
      if (!to) continue;
      if (channel === 'email' && !lead.emailValid) continue;

      const exists = await db.message.findFirst({
        where: { campaignId, leadId: lead.id, stepOrder: 1, channel },
      });
      if (exists) continue;

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

      await db.message.create({
        data: {
          workspaceId: campaign.workspaceId, campaignId, leadId: lead.id,
          stepOrder: 1, channel, toAddress: to, subject: channel === 'email' ? subject : null,
          body, trackingId: nanoid(22), status: 'queued', scheduledFor: new Date(),
        },
      });
      await db.lead.update({ where: { id: lead.id }, data: { status: 'queued' } });
      queued++;
    }
  }

  await enqueue(campaign.workspaceId, 'send_message', { campaignId });
  return { queued };
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
