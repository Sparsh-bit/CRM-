import { db } from '../lib/db';
import { canSend, inSendingWindow, localDay, nextWindowOpen } from '../lib/scheduler';
import { sendEmail, type MailboxLike } from '../lib/email/senders';
import { sendText } from '../lib/whatsapp/evolution';
import { decrypt } from '../lib/crypto';
import {
  appendPixel, isHtml, rewriteLinks, textToHtml, unsubscribeBlock, unsubscribeHeaders,
} from '../lib/email/tracking';
import { scheduleFollowUp } from '../lib/campaign';

const APP_URL = () => (process.env.APP_URL || 'http://localhost:3000').replace(/\/+$/, '');
const BATCH = Number(process.env.WORKER_BATCH ?? 25);

export type SendSweep = { sent: number; skipped: number; pending: number; retryAt: Date | null };

export async function sendDueMessages(workspaceId: string): Promise<SendSweep> {
  const workspace = await db.workspace.findUniqueOrThrow({ where: { id: workspaceId } });
  const messages = await db.message.findMany({
    where: { workspaceId, status: 'queued', scheduledFor: { lte: new Date() } },
    orderBy: { scheduledFor: 'asc' },
    take: BATCH,
    include: { lead: true, campaign: { include: { steps: { orderBy: { order: 'asc' } } } } },
  });

  let sent = 0, skipped = 0;
  let retryAt: Date | null = null;
  const bump = (d: Date | null) => { if (d && (!retryAt || d < retryAt)) retryAt = d; };

  for (const m of messages) {
    const campaign = m.campaign;

    // sending window
    if (campaign) {
      const w = {
        days: campaign.sendDays, startHour: campaign.sendStartHour,
        endHour: campaign.sendEndHour, timezone: campaign.timezone || workspace.timezone,
      };
      if (!inSendingWindow(w)) { bump(nextWindowOpen(w)); continue; }
      if (campaign.status === 'paused') continue;
    }

    // stop-on-reply / unsubscribe safety net, re-checked at send time
    if (m.lead.status === 'replied' && campaign?.stopOnReply) {
      await db.message.update({ where: { id: m.id }, data: { status: 'skipped', error: 'lead replied' } });
      skipped++; continue;
    }
    if (m.lead.status === 'unsubscribed' || m.lead.status === 'bounced') {
      await db.message.update({ where: { id: m.id }, data: { status: 'skipped', error: m.lead.status } });
      skipped++; continue;
    }
    const supp = await db.suppression.findFirst({
      where: { workspaceId, value: m.toAddress.toLowerCase() },
    });
    if (supp) {
      await db.message.update({ where: { id: m.id }, data: { status: 'skipped', error: 'suppressed' } });
      skipped++; continue;
    }

    try {
      if (m.channel === 'email') { const r = await sendViaEmail(m, workspace); if (!r) { bump(r); continue; } }
      else { const r = await sendViaWhatsApp(m, workspace); if (!r) { bump(r); continue; } }
      sent++;
      if (campaign) await scheduleFollowUp(campaign, m.lead, m.stepOrder);
      await db.lead.update({ where: { id: m.leadId }, data: { status: 'contacted' } });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await db.message.update({ where: { id: m.id }, data: { status: 'failed', error: msg.slice(0, 1500) } });
      console.error('[send]', m.id, msg);
    }
  }

  const pending = await db.message.count({
    where: { workspaceId, status: 'queued', scheduledFor: { lte: new Date() } },
  });
  return { sent, skipped, pending, retryAt };
}

type Msg = Awaited<ReturnType<typeof db.message.findMany>>[number] & { lead: { id: string } };

async function pickMailbox(workspaceId: string, tz: string) {
  const boxes = await db.mailbox.findMany({
    where: { workspaceId, status: 'active' },
    orderBy: [{ lastSentAt: 'asc' }], // round-robin: least-recently-used first
  });
  for (const mb of boxes) {
    const v = canSend(
      {
        dailyLimit: mb.dailyLimit, warmupEnabled: mb.warmupEnabled, warmupStart: mb.warmupStart,
        warmupStep: mb.warmupStep, activatedAt: mb.activatedAt, sentToday: mb.sentToday,
        sentTodayDate: mb.sentTodayDate, minGapSeconds: mb.minGapSeconds,
        jitterSeconds: mb.jitterSeconds, lastSentAt: mb.lastSentAt,
      },
      tz,
    );
    if (v.ok) return { mb, retryAt: null as Date | null };
  }
  return { mb: null, retryAt: new Date(Date.now() + 60_000) };
}

async function sendViaEmail(m: any, workspace: any): Promise<Date | null | true> {
  const tz = workspace.timezone;
  const { mb, retryAt } = await pickMailbox(workspace.id, tz);
  if (!mb) return retryAt;

  const app = APP_URL();
  const plain = m.body as string;
  let html = isHtml(plain) ? plain : textToHtml(plain);
  html += unsubscribeBlock(app, m.trackingId);
  const campaign = m.campaign;
  if (campaign?.trackClicks) html = rewriteLinks(html, app, m.trackingId);
  if (campaign?.trackOpens) html = appendPixel(html, app, m.trackingId);

  const res = await sendEmail(mb as unknown as MailboxLike, {
    to: m.toAddress,
    subject: m.subject || '(no subject)',
    html,
    text: `${plain}\n\n---\nUnsubscribe: ${app}/api/u/${m.trackingId}`,
    headers: {
      ...unsubscribeHeaders(app, m.trackingId, mb.fromEmail),
      'X-Campaign-Id': m.campaignId ?? '',
    },
  });

  const today = localDay(tz);
  await db.$transaction([
    db.message.update({
      where: { id: m.id },
      data: { status: 'sent', sentAt: new Date(), mailboxId: mb.id, providerId: res.providerId },
    }),
    db.mailbox.update({
      where: { id: mb.id },
      data: {
        lastSentAt: new Date(),
        sentToday: mb.sentTodayDate === today ? { increment: 1 } : 1,
        sentTodayDate: today,
        lastError: null,
      },
    }),
  ]);
  return true;
}

async function sendViaWhatsApp(m: any, workspace: any): Promise<Date | null | true> {
  const tz = workspace.timezone;
  const instances = await db.waInstance.findMany({
    where: { workspaceId: workspace.id, status: 'connected' },
    orderBy: [{ lastSentAt: 'asc' }],
  });
  let chosen: (typeof instances)[number] | null = null;
  for (const wa of instances) {
    const v = canSend(
      {
        dailyLimit: wa.dailyLimit, warmupEnabled: false, sentToday: wa.sentToday,
        sentTodayDate: wa.sentTodayDate, minGapSeconds: wa.minGapSeconds,
        jitterSeconds: wa.jitterSeconds, lastSentAt: wa.lastSentAt,
      },
      tz,
    );
    if (v.ok) { chosen = wa; break; }
  }
  if (!chosen) return new Date(Date.now() + 60_000);

  const res = await sendText(chosen.instanceName, m.toAddress, m.body, {
    delayMs: 1200,
    token: chosen.tokenEnc ? decrypt(chosen.tokenEnc) : undefined,
  });

  const today = localDay(tz);
  await db.$transaction([
    db.message.update({
      where: { id: m.id },
      data: { status: 'sent', sentAt: new Date(), waInstanceId: chosen.id, providerId: res.key?.id ?? null },
    }),
    db.waInstance.update({
      where: { id: chosen.id },
      data: {
        lastSentAt: new Date(),
        sentToday: chosen.sentTodayDate === today ? { increment: 1 } : 1,
        sentTodayDate: today,
      },
    }),
  ]);
  return true;
}
