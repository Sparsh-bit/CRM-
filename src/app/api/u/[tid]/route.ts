import { db } from '@/lib/db';

async function optOut(tid: string) {
  const m = await db.message.findUnique({ where: { trackingId: tid }, include: { lead: true } });
  if (!m) return false;
  const value = (m.toAddress || '').toLowerCase();
  await db.$transaction([
    db.suppression.upsert({
      where: { workspaceId_value: { workspaceId: m.workspaceId, value } },
      create: {
        workspaceId: m.workspaceId, value,
        kind: m.channel === 'email' ? 'email' : 'phone', reason: 'unsubscribed',
      },
      update: {},
    }),
    db.lead.update({ where: { id: m.leadId }, data: { status: 'unsubscribed' } }),
    db.event.create({ data: { messageId: m.id, type: 'unsubscribe' } }),
    db.message.updateMany({
      where: { leadId: m.leadId, status: 'queued' },
      data: { status: 'skipped', error: 'unsubscribed' },
    }),
  ]);
  return true;
}

// Found by a peer session's audit: a transient DB error inside optOut()
// used to crash both handlers uncaught into Next's generic 500 HTML page
// instead of a real response. Now caught and reported honestly — a genuine
// server error is a distinct outcome from "this link doesn't resolve to a
// real message" (`ok === false`), never conflated as the same thing.
async function safeOptOut(tid: string): Promise<{ ok: boolean; error: boolean }> {
  try {
    return { ok: await optOut(tid), error: false };
  } catch (e) {
    console.error('[unsubscribe]', e);
    return { ok: false, error: true };
  }
}

export async function POST(_req: Request, { params }: { params: Promise<{ tid: string }> }) {
  const { tid } = await params;
  const { error } = await safeOptOut(tid);
  return new Response(null, { status: error ? 500 : 200 });
}

export async function GET(_req: Request, { params }: { params: Promise<{ tid: string }> }) {
  const { tid } = await params;
  const { ok, error } = await safeOptOut(tid);
  const heading = ok ? 'You are unsubscribed.' : error ? 'Something went wrong.' : 'Link not recognised.';
  const detail = ok
    ? 'You will not receive any further messages from this sender.'
    : error
      ? 'We hit a temporary error processing this request — please try the link again in a moment.'
      : 'This unsubscribe link is invalid or has expired.';
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>Unsubscribed</title>
<div style="font-family:system-ui;max-width:460px;margin:15vh auto;text-align:center;line-height:1.6">
<h2 style="font-weight:600">${heading}</h2>
<p style="color:#666">${detail}</p>
</div>`,
    { status: error ? 500 : 200, headers: { 'content-type': 'text/html; charset=utf-8' } },
  );
}
