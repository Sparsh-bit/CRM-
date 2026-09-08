import Link from 'next/link';
import { redirect } from 'next/navigation';
import { db } from '@/lib/db';
import { getSession, requireRole } from '@/lib/session';
import { encrypt } from '@/lib/crypto';
import { effectiveDailyLimit, localDay } from '@/lib/scheduler';
import { mailboxStatusMeta, pillClass } from '@/lib/ui/status';
import { verifyMailbox, humanizeEmailError } from '@/lib/email/senders';
import { encodeErrorDisplay } from '@/lib/errors/display';
import { ErrorDetail } from '@/components/ErrorDetail';

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

/**
 * A real connection check — no email is sent. Never flips a deliberately
 * paused mailbox back to active on its own; a pause is an admin decision,
 * a test result is just information about whether credentials still work.
 */
async function test(formData: FormData) {
  'use server';
  const s = await getSession();
  if (!s) redirect('/login');
  const id = String(formData.get('id'));
  const mb = await db.mailbox.findFirstOrThrow({ where: { id, workspaceId: s.workspaceId } });
  try {
    await verifyMailbox(mb);
    await db.mailbox.update({
      where: { id },
      data: { lastError: null, ...(mb.status === 'paused' ? {} : { status: 'active' }) },
    });
  } catch (e) {
    const h = humanizeEmailError(e, mb.provider);
    await db.mailbox.update({
      where: { id },
      data: { lastError: encodeErrorDisplay(h), ...(mb.status === 'paused' ? {} : { status: 'error' }) },
    });
  }
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
        <div className="flex items-baseline justify-between gap-4 flex-wrap">
          <h1 className="text-2xl font-semibold">Mailboxes</h1>
          <Link href="/help/email" className="text-sm text-accent whitespace-nowrap">How do I set this up? →</Link>
        </div>
        <p className="text-sm text-muted mt-1">
          Sends rotate across active mailboxes, least-recently-used first. Today: {totalToday} of {capacity} available sends.
        </p>
      </div>

      {/* Mobile: a status/error/action row buried in an off-screen table column has no
          visual hint it's reachable by scroll — a stacked card surfaces it directly instead. */}
      <div className="md:hidden space-y-3">
        {boxes.map((mb) => (
          <div key={mb.id} className="card space-y-2">
            <div className="flex justify-between items-start gap-2">
              <div>
                <div className="font-medium">{mb.label}</div>
                <div className="text-xs text-muted">{mb.fromName} &lt;{mb.fromEmail}&gt;</div>
              </div>
              <span className={pillClass(mailboxStatusMeta(mb.status).tone)}>{mb.status}</span>
            </div>
            <ErrorDetail raw={mb.lastError} />
            <div className="text-xs text-muted">
              {mb.provider} · {mb.sentTodayDate === today ? mb.sentToday : 0} sent today · cap {effectiveDailyLimit({ ...mb, sentToday: 0, sentTodayDate: null } as never)}/{mb.dailyLimit} · gap {mb.minGapSeconds}s+{mb.jitterSeconds}s
            </div>
            <div className="flex gap-3">
              <form action={test}><input type="hidden" name="id" value={mb.id} /><button className="text-xs text-accent hover:opacity-80">Test connection</button></form>
              <form action={toggle}><input type="hidden" name="id" value={mb.id} />
                <button className="text-xs text-muted hover:text-slate-200">{mb.status === 'active' ? 'Pause' : 'Resume'}</button>
              </form>
            </div>
          </div>
        ))}
        {!boxes.length && <div className="text-sm text-muted">No mailboxes yet. Add one below.</div>}
      </div>

      <div className="hidden md:block card p-0 overflow-x-auto">
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
                  <div className="mt-1 max-w-xs"><ErrorDetail raw={mb.lastError} /></div>
                </td>
                <td className="td">
                  <div className="flex flex-col gap-1.5 items-start">
                    <form action={test}><input type="hidden" name="id" value={mb.id} /><button className="text-xs text-accent hover:opacity-80">Test connection</button></form>
                    <form action={toggle}><input type="hidden" name="id" value={mb.id} />
                      <button className="text-xs text-muted hover:text-slate-200">{mb.status === 'active' ? 'Pause' : 'Resume'}</button>
                    </form>
                  </div>
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

        <details className="rounded-lg border border-line p-4" open>
          <summary className="text-sm cursor-pointer">SMTP credentials</summary>
          <div className="grid md:grid-cols-4 gap-4 mt-4">
            <div><label className="label">Host</label><input className="input" name="smtpHost" placeholder="smtp.gmail.com" /></div>
            <div><label className="label">Port</label><input className="input" name="smtpPort" type="number" defaultValue={465} /></div>
            <div><label className="label">Username</label><input className="input" name="smtpUser" placeholder="you@gmail.com" /></div>
            <div><label className="label">Password / app password</label><input className="input" name="smtpPass" type="password" /></div>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="smtpSecure" defaultChecked /> TLS</label>
          </div>
          <p className="text-xs text-warn mt-3">
            Use a Google App Password, not your normal Google password — Gmail and Google Workspace both reject
            SMTP logins with a regular account password once 2-Step Verification is on.{' '}
            <Link href="/help/email/gmail" className="text-accent">How do I create one? →</Link>
          </p>
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
