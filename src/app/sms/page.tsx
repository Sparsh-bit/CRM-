import { redirect } from 'next/navigation';
import { getSession, requireRole } from '@/lib/session';
import { smsGatewayStatusMeta, pillClass } from '@/lib/ui/status';
import {
  createGateway, updateGateway, deleteGateway, disableGateway, checkGatewayConnection, listGateways, type SmsActor,
} from '@/lib/sms/gateways';

export const dynamic = 'force-dynamic';

/**
 * SMS gateway management — the customer-facing surface for the SmsGateway
 * service layer built in Phase 5 (src/lib/sms/gateways.ts), which already
 * documented itself as "the service layer a future /sms settings page wires
 * up to." Same admin-gated, same shape as /mailboxes and /whatsapp — no
 * duplicate provider system, this page only calls the existing service.
 */
async function add(formData: FormData) {
  'use server';
  const s = await getSession();
  if (!s) redirect('/login');
  const { role } = await requireRole('admin');
  const actor: SmsActor = { workspaceId: s.workspaceId, role };
  await createGateway(actor, {
    label: String(formData.get('label') || 'SMS Gateway'),
    phoneNumber: String(formData.get('phoneNumber') || ''),
    apiKey: String(formData.get('apiKey') || ''),
    dailyLimit: Number(formData.get('dailyLimit') || 100),
    minGapSeconds: Number(formData.get('minGapSeconds') || 30),
  });
  redirect('/sms');
}

async function test(formData: FormData) {
  'use server';
  const s = await getSession();
  if (!s) redirect('/login');
  await checkGatewayConnection(s.workspaceId, String(formData.get('id')));
  redirect('/sms');
}

async function toggle(formData: FormData) {
  'use server';
  const s = await getSession();
  if (!s) redirect('/login');
  const { role } = await requireRole('admin');
  const actor: SmsActor = { workspaceId: s.workspaceId, role };
  const id = String(formData.get('id'));
  const currentlyDisabled = String(formData.get('currentlyDisabled') || '') === '1';
  if (currentlyDisabled) await updateGateway(actor, id, { status: 'disconnected' });
  else await disableGateway(actor, id);
  redirect('/sms');
}

async function remove(formData: FormData) {
  'use server';
  const s = await getSession();
  if (!s) redirect('/login');
  const { role } = await requireRole('admin');
  await deleteGateway({ workspaceId: s.workspaceId, role }, String(formData.get('id')));
  redirect('/sms');
}

export default async function SmsPage() {
  const s = await getSession();
  if (!s) redirect('/login');
  const gateways = await listGateways(s.workspaceId);

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold">SMS</h1>
        <p className="text-sm text-muted mt-1">
          Connects through <a className="text-accent" href="https://httpsms.com">httpSMS</a> — the only provider implemented so far.
          Credentials are encrypted with AES-256-GCM before they touch the database.
        </p>
      </div>

      <div className="grid md:grid-cols-2 gap-4">
        {gateways.map((gw) => (
          <div key={gw.id} className="card space-y-3">
            <div className="flex justify-between items-start">
              <div>
                <div className="font-medium">{gw.label}</div>
                <div className="text-xs text-muted">{gw.phoneNumber} · {gw.provider}</div>
              </div>
              <span className={pillClass(smsGatewayStatusMeta(gw.status).tone)}>{gw.status}</span>
            </div>
            {gw.lastError && <div className="text-xs text-bad break-words">{gw.lastError}</div>}
            <div className="text-xs text-muted">Cap {gw.dailyLimit}/day · gap {gw.minGapSeconds}s +{gw.jitterSeconds}s jitter · sent today {gw.sentToday}</div>
            <div className="flex gap-2 flex-wrap">
              <form action={test}><input type="hidden" name="id" value={gw.id} /><button className="btn-sec text-xs">Test connection</button></form>
              <form action={toggle}>
                <input type="hidden" name="id" value={gw.id} />
                <input type="hidden" name="currentlyDisabled" value={gw.status === 'disconnected' ? '1' : '0'} />
                <button className="text-xs text-muted hover:text-slate-200">{gw.status === 'disconnected' ? 'Re-enable' : 'Disconnect'}</button>
              </form>
              <form action={remove}><input type="hidden" name="id" value={gw.id} /><button className="text-xs text-muted hover:text-bad px-2">Remove</button></form>
            </div>
          </div>
        ))}
        {!gateways.length && <div className="text-sm text-muted">No SMS gateway connected yet.</div>}
      </div>

      <form action={add} className="card space-y-4">
        <div className="font-medium">Connect an SMS gateway</div>
        <div className="grid md:grid-cols-4 gap-4">
          <div><label className="label">Label</label><input className="input" name="label" placeholder="Support line" required /></div>
          <div><label className="label">Phone number</label><input className="input" name="phoneNumber" placeholder="+15551234567" required /></div>
          <div><label className="label">API key</label><input className="input" name="apiKey" type="password" required /></div>
          <div><label className="label">Daily limit</label><input className="input" name="dailyLimit" type="number" defaultValue={100} /></div>
        </div>
        <div className="grid md:grid-cols-4 gap-4">
          <div><label className="label">Min gap between sends (s)</label><input className="input" name="minGapSeconds" type="number" defaultValue={30} /></div>
        </div>
        <p className="text-xs text-muted">A new gateway starts "disconnected" until Test connection confirms it — never claimed connected without a real check.</p>
        <button className="btn">Connect</button>
      </form>
    </div>
  );
}
