import { db } from '@/lib/db';

/**
 * Evolution posts every subscribed event here.
 * Two matter: an inbound message (a reply → stop the sequence) and a
 * connection state change (so the UI reports connected/disconnected honestly).
 */
export async function POST(req: Request) {
  // Fail CLOSED, not open (found by a peer session's audit): this used to
  // only check the secret `if (secret && ...)`, so an unset/misconfigured
  // EVOLUTION_WEBHOOK_SECRET meant every request was accepted unauthenticated
  // — anyone who found this URL could forge a connection-state update or a
  // fake "replied" that silently stops a real send sequence. Now a missing
  // secret refuses every request rather than accepting all of them.
  const secret = process.env.EVOLUTION_WEBHOOK_SECRET;
  if (!secret || new URL(req.url).searchParams.get('secret') !== secret) {
    return new Response('forbidden', { status: 403 });
  }

  const body = (await req.json().catch(() => ({}))) as Record<string, any>;
  const event = String(body.event ?? '').toUpperCase().replace(/\./g, '_');
  const instanceName = String(body.instance ?? body.instanceName ?? '');

  try {
    if (event === 'CONNECTION_UPDATE') {
      const state = String(body.data?.state ?? '');
      await db.waInstance.updateMany({
        where: { instanceName },
        data: { status: state === 'open' ? 'connected' : state === 'connecting' ? 'qr' : 'disconnected' },
      });
    }

    if (event === 'MESSAGES_UPSERT') {
      const key = body.data?.key ?? {};
      if (key.fromMe) return new Response('ok');
      const jid = String(key.remoteJid ?? '');
      const phone = '+' + jid.split('@')[0].replace(/[^\d]/g, '');
      await markReplied(instanceName, phone);
    }
  } catch (e) {
    console.error('[evolution webhook]', e);
  }

  return new Response('ok');
}

async function markReplied(instanceName: string, phone: string) {
  const wa = await db.waInstance.findUnique({ where: { instanceName } });
  if (!wa) return;
  const lead = await db.lead.findFirst({ where: { workspaceId: wa.workspaceId, phone } });
  if (!lead) return;

  const last = await db.message.findFirst({
    where: { leadId: lead.id, channel: 'whatsapp', status: 'sent' },
    orderBy: { sentAt: 'desc' },
  });

  await db.$transaction([
    db.lead.update({ where: { id: lead.id }, data: { status: 'replied' } }),
    db.message.updateMany({
      where: { leadId: lead.id, status: 'queued' },
      data: { status: 'skipped', error: 'lead replied' },
    }),
    ...(last
      ? [
          db.message.update({ where: { id: last.id }, data: { repliedAt: new Date() } }),
          db.event.create({ data: { messageId: last.id, type: 'reply' } }),
        ]
      : []),
  ]);
}
