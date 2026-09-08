import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/session';

export const dynamic = 'force-dynamic';

export default async function EmailHelpIndex() {
  const s = await getSession();
  if (!s) redirect('/login');

  return (
    <div className="space-y-8">
      <Link href="/help" className="text-sm text-muted hover:text-slate-200">← Help</Link>
      <div>
        <h1 className="text-2xl font-semibold">Email setup</h1>
        <p className="text-sm text-muted mt-1">Four provider choices on <Link href="/mailboxes" className="text-accent">Mailboxes</Link>: SMTP, Resend, Gmail OAuth, Outlook OAuth.</p>
      </div>

      <div className="card space-y-2">
        <div className="font-medium">SMTP (Gmail / Google Workspace, or any SMTP inbox)</div>
        <p className="text-sm text-muted">
          The most common choice. If your address ends in @gmail.com or a Google Workspace domain, you need a
          Google App Password, not your normal Google password. <Link href="/help/email/gmail" className="text-accent">Full step-by-step guide →</Link>
        </p>
        <p className="text-sm text-muted">For any other SMTP provider, use the host/port your provider gives you — port 465 with TLS on, or 587 with TLS off (STARTTLS).</p>
      </div>

      <div className="card space-y-2">
        <div className="font-medium">Resend</div>
        <p className="text-sm text-muted">Paste your Resend API key (from resend.com/api-keys) into the "API key (Resend)" field on Mailboxes. No SMTP fields needed.</p>
      </div>

      <div className="card space-y-2">
        <div className="font-medium">Gmail OAuth / Outlook OAuth</div>
        <p className="text-sm text-muted">
          For a workspace admin who has already connected an OAuth grant for this mailbox — this app doesn't yet expose a self-serve
          "Connect with Google/Microsoft" button, so these two are set up by whoever configured your deployment.
        </p>
      </div>

      <div className="card space-y-2">
        <div className="font-medium">Testing a connection</div>
        <p className="text-sm text-muted">
          Every mailbox on the Mailboxes page has a <strong>Test connection</strong> link. It performs a real check —
          for SMTP that means logging in without sending anything — and never marks a mailbox "active" unless the
          check actually succeeded. A failure shows a plain-language reason, with the raw technical detail available
          under "Technical details" if you need it.
        </p>
      </div>
    </div>
  );
}
