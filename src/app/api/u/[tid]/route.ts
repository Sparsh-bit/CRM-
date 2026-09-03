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

export async function POST(_req: Request, { params }: { params: Promise<{ tid: string }> }) {
  const { tid } = await params;
  await optOut(tid);
  return new Response(null, { status: 200 });
}

export async function GET(_req: Request, { params }: { params: Promise<{ tid: string }> }) {
  const { tid } = await params;
  const ok = await optOut(tid);
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>Unsubscribed</title>
<div style="font-family:system-ui;max-width:460px;margin:15vh auto;text-align:center;line-height:1.6">
<h2 style="font-weight:600">${ok ? 'You are unsubscribed.' : 'Link not recognised.'}</h2>
<p style="color:#666">${ok ? 'You will not receive any further messages from this sender.' : 'This unsubscribe link is invalid or has expired.'}</p>
</div>`,
    { headers: { 'content-type': 'text/html; charset=utf-8' } },
  );
}
