import { redirect } from 'next/navigation';
import { db } from '@/lib/db';
import { getSession, requireRole } from '@/lib/session';
import { encrypt } from '@/lib/crypto';
import { effectiveDailyLimit, localDay } from '@/lib/scheduler';
import { mailboxStatusMeta, pillClass } from '@/lib/ui/status';

export const dynamic = 'force-dynamic';

/**
 * A mailbox is credentials plus sending capacity, so every write here is
 * admin-level: a member can send from a mailbox; only an admin can add,
 * pause or resume one.
 */
async function addMailbox(formData: FormData) {
  'use server';
  const s = await getSession();
  if (!s) redirect('/login');
  await requireRole('admin');
  const provider = String(formData.get('provider') || 'smtp');
  const pass = String(formData.get('smtpPass') || '');
  const apiKey = String(formData.get('apiKey') || '');

  await db.mailbox.create({
    data: {
      workspaceId: s.workspaceId,
      label: String(formData.get('label') || 'Mailbox'),
      fromName: String(formData.get('fromName') || ''),
      fromEmail: String(formData.get('fromEmail') || '').toLowerCase(),
      replyTo: String(formData.get('replyTo') || '') || null,
      provider,
      smtpHost: String(formData.get('smtpHost') || '') || null,
      smtpPort: Number(formData.get('smtpPort') || 465),
      smtpSecure: String(formData.get('smtpSecure') || 'on') === 'on',
      smtpUser: String(formData.get('smtpUser') || '') || null,
      smtpPassEnc: pass ? encrypt(pass) : null,
      apiKeyEnc: apiKey ? encrypt(apiKey) : null,
      dailyLimit: Number(formData.get('dailyLimit') || 50),
      minGapSeconds: Number(formData.get('minGapSeconds') || 90),
      warmupEnabled: String(formData.get('warmup') || '') === 'on',
    },
  });
  redirect('/mailboxes');
}

async function toggle(formData: FormData) {
  'use server';
  const s = await getSession();
  if (!s) redirect('/login');
  await requireRole('admin');
  const id = String(formData.get('id'));
  const mb = await db.mailbox.findFirstOrThrow({ where: { id, workspaceId: s.workspaceId } });
  await db.mailbox.update({ where: { id }, data: { status: mb.status === 'active' ? 'paused' : 'active' } });
  redirect('/mailboxes');
}

export default async function Mailboxes() {
  const s = await getSession();
  if (!s) redirect('/login');
  const ws = await db.workspace.findUniqueOrThrow({ where: { id: s.workspaceId } });
  const boxes = await db.mailbox.findMany({ where: { workspaceId: s.workspaceId }, orderBy: { createdAt: 'asc' } });
  const today = localDay(ws.timezone);
  const totalToday = boxes.reduce((n, mb) => n + (mb.sentTodayDate === today ? mb.sentToday : 0), 0);
  const capacity = boxes.filter((b) => b.status === 'active')
    .reduce((n, mb) => n + effectiveDailyLimit({ ...mb, sentToday: 0, sentTodayDate: null } as never), 0);

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold">Mailboxes</h1>
        <p className="text-sm text-muted mt-1">
          Sends rotate across active mailboxes, least-recently-used first. Today: {totalToday} of {capacity} available sends.
        </p>
      </div>

      <div className="card p-0 overflow-x-auto">
        <table className="w-full">
          <thead className="bg-ink"><tr>
            {['Mailbox', 'Provider', 'Today', 'Cap (warmup)', 'Gap', 'Status', ''].map((h) => <th key={h} className="th">{h}</th>)}
          </tr></thead>
          <tbody>
            {boxes.map((mb) => (
              <tr key={mb.id}>
                <td className="td"><div>{mb.label}</div><div className="text-xs text-muted">{mb.fromName} &lt;{mb.fromEmail}&gt;</div></td>
                <td className="td text-muted">{mb.provider}</td>
                <td className="td">{mb.sentTodayDate === today ? mb.sentToday : 0}</td>
                <td className="td">{effectiveDailyLimit({ ...mb, sentToday: 0, sentTodayDate: null } as never)} / {mb.dailyLimit}</td>
                <td className="td text-muted">{mb.minGapSeconds}s +{mb.jitterSeconds}s</td>
                <td className="td">
                  <span className={pillClass(mailboxStatusMeta(mb.status).tone)}>{mb.status}</span>
                  {mb.lastError && <div className="text-xs text-bad mt-1 max-w-xs truncate">{mb.lastError}</div>}
                </td>
                <td className="td">
                  <form action={toggle}><input type="hidden" name="id" value={mb.id} />
                    <button className="text-xs text-muted hover:text-slate-200">{mb.status === 'active' ? 'Pause' : 'Resume'}</button>
                  </form>
                </td>
              </tr>
            ))}
            {!boxes.length && <tr><td className="td text-muted" colSpan={7}>No mailboxes yet. Add one below.</td></tr>}
          </tbody>
        </table>
      </div>

      <form action={addMailbox} className="card space-y-4">
        <div className="font-medium">Add a mailbox</div>
        <div className="grid md:grid-cols-3 gap-4">
          <div><label className="label">Label</label><input className="input" name="label" placeholder="Krishna – Google Workspace" required /></div>
          <div><label className="label">From name</label><input className="input" name="fromName" placeholder="Krishna" required /></div>
          <div><label className="label">From email</label><input className="input" name="fromEmail" type="email" required /></div>
          <div><label className="label">Reply-to (optional)</label><input className="input" name="replyTo" type="email" /></div>
          <div>
            <label className="label">Provider</label>
            <select className="input" name="provider" defaultValue="smtp">
              <option value="smtp">SMTP / Gmail app password</option>
              <option value="resend">Resend API</option>
              <option value="gmail_oauth">Gmail OAuth</option>
              <option value="outlook_oauth">Outlook OAuth</option>
            </select>
          </div>
        </div>

        <details className="rounded-lg border border-line p-4">
          <summary className="text-sm cursor-pointer">SMTP credentials</summary>
          <div className="grid md:grid-cols-4 gap-4 mt-4">
            <div><label className="label">Host</label><input className="input" name="smtpHost" placeholder="smtp.gmail.com" /></div>
            <div><label className="label">Port</label><input className="input" name="smtpPort" type="number" defaultValue={465} /></div>
            <div><label className="label">Username</label><input className="input" name="smtpUser" /></div>
            <div><label className="label">Password / app password</label><input className="input" name="smtpPass" type="password" /></div>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="smtpSecure" defaultChecked /> TLS</label>
          </div>
        </details>

        <details className="rounded-lg border border-line p-4">
          <summary className="text-sm cursor-pointer">API key (Resend)</summary>
          <div className="mt-4"><label className="label">API key</label><input className="input" name="apiKey" type="password" placeholder="re_..." /></div>
        </details>

        <div className="grid md:grid-cols-3 gap-4">
          <div><label className="label">Daily limit</label><input className="input" name="dailyLimit" type="number" defaultValue={50} /></div>
          <div><label className="label">Minimum gap between sends (s)</label><input className="input" name="minGapSeconds" type="number" defaultValue={90} /></div>
          <label className="flex items-end gap-2 text-sm pb-2"><input type="checkbox" name="warmup" defaultChecked /> Warm up (10/day, +5/day)</label>
        </div>
        <p className="text-xs text-muted">
          Credentials are encrypted with AES-256-GCM before they touch the database. Keep daily limits
          conservative on a new domain — a cold Google Workspace mailbox should not exceed ~30–50 cold sends a day.
        </p>
        <button className="btn">Add mailbox</button>
      </form>
    </div>
  );
}
