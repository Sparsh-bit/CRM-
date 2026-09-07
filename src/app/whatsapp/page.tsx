import { redirect } from 'next/navigation';
import { db } from '@/lib/db';
import { getSession, requireRole } from '@/lib/session';
import { createInstance, connectInstance, connectionState, deleteInstance } from '@/lib/whatsapp/evolution';
import { encrypt } from '@/lib/crypto';
import { appUrl } from '@/lib/env';

export const dynamic = 'force-dynamic';

/**
 * Pairing and deleting a number are admin-level, as with mailboxes: this is a
 * credentialed channel connection, not routine day-to-day use.
 */
async function addInstance(formData: FormData) {
  'use server';
  const s = await getSession();
  if (!s) redirect('/login');
  await requireRole('admin');
  const label = String(formData.get('label') || 'WhatsApp');
  const instanceName = String(formData.get('instanceName') || '').replace(/[^a-zA-Z0-9_-]/g, '') || `wa_${Date.now()}`;
  const number = String(formData.get('number') || '').replace(/\D/g, '') || undefined;

  const app = appUrl();
  const secret = process.env.EVOLUTION_WEBHOOK_SECRET;
  const hook = `${app}/api/webhooks/evolution${secret ? `?secret=${encodeURIComponent(secret)}` : ''}`;

  let tokenEnc: string | null = null;
  let status = 'disconnected';
  try {
    const res = await createInstance(instanceName, number, hook);
    const hash = typeof res.hash === 'string' ? res.hash : res.hash?.apikey;
    if (hash) tokenEnc = encrypt(hash);
    status = 'qr';
  } catch (e) {
    status = 'error';
    await db.waInstance.create({
      data: {
        workspaceId: s.workspaceId, label, instanceName, number: number ?? null,
        status, lastError: e instanceof Error ? e.message : String(e),
      },
    });
    redirect('/whatsapp');
  }

  await db.waInstance.create({
    data: {
      workspaceId: s.workspaceId, label, instanceName, number: number ?? null, status, tokenEnc,
      dailyLimit: Number(formData.get('dailyLimit') || 150),
      minGapSeconds: Number(formData.get('minGapSeconds') || 45),
    },
  });
  redirect('/whatsapp');
}

async function refresh(formData: FormData) {
  'use server';
  const s = await getSession();
  if (!s) redirect('/login');
  const id = String(formData.get('id'));
  const wa = await db.waInstance.findFirstOrThrow({ where: { id, workspaceId: s.workspaceId } });
  try {
    const st = await connectionState(wa.instanceName);
    const state = st.instance?.state ?? 'close';
    await db.waInstance.update({
      where: { id },
      data: { status: state === 'open' ? 'connected' : state === 'connecting' ? 'qr' : 'disconnected', lastError: null },
    });
  } catch (e) {
    await db.waInstance.update({ where: { id }, data: { status: 'error', lastError: e instanceof Error ? e.message : String(e) } });
  }
  redirect('/whatsapp');
}

async function remove(formData: FormData) {
  'use server';
  const s = await getSession();
  if (!s) redirect('/login');
  await requireRole('admin');
  const id = String(formData.get('id'));
  const wa = await db.waInstance.findFirstOrThrow({ where: { id, workspaceId: s.workspaceId } });
  try { await deleteInstance(wa.instanceName); } catch { /* already gone */ }
  await db.waInstance.delete({ where: { id } });
  redirect('/whatsapp');
}

export default async function WhatsAppPage() {
  const s = await getSession();
  if (!s) redirect('/login');
  const list = await db.waInstance.findMany({ where: { workspaceId: s.workspaceId }, orderBy: { createdAt: 'asc' } });

  const qrs = await Promise.all(
    list.map(async (wa) => {
      if (wa.status !== 'qr') return null;
      try { const r = await connectInstance(wa.instanceName); return r.base64 ?? null; } catch { return null; }
    }),
  );

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold">WhatsApp</h1>
        <p className="text-sm text-muted mt-1">
          Numbers connect through a self-hosted <a className="text-accent" href="https://github.com/EvolutionAPI/evolution-api">Evolution API</a> gateway.
          Set <code className="text-slate-300">EVOLUTION_API_URL</code> and <code className="text-slate-300">EVOLUTION_API_KEY</code> first.
        </p>
      </div>

      <div className="grid md:grid-cols-2 gap-4">
        {list.map((wa, i) => (
          <div key={wa.id} className="card space-y-3">
            <div className="flex justify-between items-start">
              <div>
                <div className="font-medium">{wa.label}</div>
                <div className="text-xs text-muted">{wa.instanceName}{wa.number ? ` · +${wa.number}` : ''}</div>
              </div>
              <span className={`pill ${wa.status === 'connected' ? 'bg-good/20 text-good' : wa.status === 'error' ? 'bg-bad/20 text-bad' : 'bg-warn/20 text-warn'}`}>{wa.status}</span>
            </div>
            {wa.lastError && <div className="text-xs text-bad break-words">{wa.lastError}</div>}
            {qrs[i] && (
              <div>
                <div className="text-xs text-muted mb-2">WhatsApp → Linked devices → Link a device</div>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={qrs[i] as string} alt="WhatsApp QR" className="w-48 h-48 bg-white rounded-lg p-2" />
              </div>
            )}
            <div className="text-xs text-muted">Cap {wa.dailyLimit}/day · gap {wa.minGapSeconds}s +{wa.jitterSeconds}s jitter · sent today {wa.sentToday}</div>
            <div className="flex gap-2">
              <form action={refresh}><input type="hidden" name="id" value={wa.id} /><button className="btn-sec text-xs">Refresh status</button></form>
              <form action={remove}><input type="hidden" name="id" value={wa.id} /><button className="text-xs text-muted hover:text-bad px-2">Remove</button></form>
            </div>
          </div>
        ))}
        {!list.length && <div className="text-sm text-muted">No numbers connected yet.</div>}
      </div>

      <form action={addInstance} className="card space-y-4">
        <div className="font-medium">Connect a number</div>
        <div className="grid md:grid-cols-4 gap-4">
          <div><label className="label">Label</label><input className="input" name="label" placeholder="Sales line" required /></div>
          <div><label className="label">Instance name</label><input className="input" name="instanceName" placeholder="concilio_sales" required /></div>
          <div><label className="label">Number (optional, for pairing code)</label><input className="input" name="number" placeholder="919876543210" /></div>
          <div><label className="label">Daily limit</label><input className="input" name="dailyLimit" type="number" defaultValue={150} /></div>
        </div>
        <div className="grid md:grid-cols-4 gap-4">
          <div><label className="label">Min gap between messages (s)</label><input className="input" name="minGapSeconds" type="number" defaultValue={45} /></div>
        </div>
        <p className="text-xs text-warn">
          Cold WhatsApp outreach to people who never opted in gets numbers banned, and in several
          countries it is also a legal problem. Keep volumes low, personalise every message, honour
          opt-outs immediately, and never message a number that has already asked you to stop.
        </p>
        <button className="btn">Create instance</button>
      </form>
    </div>
  );
}
