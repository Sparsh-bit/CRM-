import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/session';
import { StepGuide, VerifiedSource, type Step } from '@/components/StepGuide';

export const dynamic = 'force-dynamic';

const STEPS: Step[] = [
  {
    title: 'Turn on 2-Step Verification',
    description: <>App Passwords only exist for accounts that have 2-Step Verification enabled — Google won't offer the option otherwise. In your Google Account, go to <strong>Security → 2-Step Verification</strong> and turn it on if it isn't already.</>,
  },
  {
    title: 'Open the App Passwords page',
    description: 'Go to myaccount.google.com/apppasswords (you may need to sign in again).',
    copy: { value: 'https://myaccount.google.com/apppasswords', label: 'App Passwords page' },
  },
  {
    title: 'Create a new App Password',
    description: <>Give it a name you'll recognise later (e.g. "OutreachPilot") and create it. Google generates a 16-character passcode — that&apos;s the App Password.</>,
    note: 'This passcode is shown once. Copy it immediately — you cannot view it again after leaving the page (you can always generate a new one, though).',
  },
  {
    title: 'Enter it in OutreachPilot — not your normal password',
    description: <>On <Link href="/mailboxes" className="text-accent">Mailboxes → Add a mailbox</Link>, set Provider to "SMTP / Gmail app password", Username to your full Gmail/Workspace address, and paste the 16-character App Password into the Password field.</>,
    note: 'Use the App Password here, never your normal Google account password — a normal password will fail with an authentication error once 2-Step Verification is on.',
  },
  {
    title: 'Set host, port, and TLS',
    description: 'Host smtp.gmail.com. Port 465 with TLS on (recommended), or port 587 with TLS off (STARTTLS) if your network blocks 465.',
    copy: { value: 'smtp.gmail.com', label: 'SMTP host' },
  },
  {
    title: 'Test the connection',
    description: <>Save the mailbox, then click <strong>Test connection</strong> on the Mailboxes page. This logs in without sending an email — a real pass/fail, not a guess.</>,
  },
];

export default async function GmailHelpPage() {
  const s = await getSession();
  if (!s) redirect('/login');

  return (
    <div className="space-y-8">
      <Link href="/help/email" className="text-sm text-muted hover:text-slate-200">← Email setup</Link>
      <div>
        <h1 className="text-2xl font-semibold">Gmail / Google Workspace App Password</h1>
        <p className="text-sm text-warn mt-1">Use a Google App Password, not your normal Google password.</p>
      </div>

      <StepGuide steps={STEPS} />

      <VerifiedSource
        verifiedOn="September 8, 2026"
        sources={[
          { label: 'Google Account Help — Sign in with app passwords', href: 'https://support.google.com/accounts/answer/185833' },
          { label: 'Google Workspace Help — Send email from a printer, scanner, or app (SMTP settings)', href: 'https://support.google.com/a/answer/176600' },
        ]}
      />
    </div>
  );
}
