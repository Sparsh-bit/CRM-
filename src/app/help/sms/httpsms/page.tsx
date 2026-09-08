import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/session';
import { StepGuide, VerifiedSource, type Step } from '@/components/StepGuide';

export const dynamic = 'force-dynamic';

const STEPS: Step[] = [
  {
    title: 'Requirements',
    description: 'An Android phone with a SIM card and an active plan, and a working internet connection (Wi-Fi or mobile data) on that phone — httpSMS relays through it, it doesn\'t replace it.',
  },
  {
    title: 'Install the httpSMS Android app',
    description: 'Install it on the phone that will actually send the messages, either from the Play Store listing or the APK on the httpSMS site.',
  },
  {
    title: 'Create an account and get an API key',
    description: 'Sign in at httpsms.com and open the Settings page to generate an API key.',
    copy: { value: 'https://httpsms.com/settings', label: 'httpSMS settings' },
    note: 'Do not share your API key. Treat it like a password — anyone with it can send SMS through your phone and your plan.',
  },
  {
    title: 'Sign in on the Android app',
    description: 'Open the app on the phone and sign in with the same httpSMS account. This is what lets the phone receive send requests.',
  },
  {
    title: 'Connect the gateway in OutreachPilot',
    description: <>On the <Link href="/sms" className="text-accent">SMS</Link> page, add a gateway with the phone number exactly as registered on httpSMS, and paste <code className="text-slate-300">YOUR_API_KEY</code> into the API key field.</>,
  },
  {
    title: 'Test the connection',
    description: <>Click <strong>Test connection</strong>. This confirms the API key is valid and that phone number is registered on the account — it does not confirm the phone is online at this exact moment, since httpSMS doesn't expose that as a live API field.</>,
  },
];

export default async function HttpSmsHelpPage() {
  const s = await getSession();
  if (!s) redirect('/login');

  return (
    <div className="space-y-8">
      <Link href="/help/sms" className="text-sm text-muted hover:text-slate-200">← SMS setup</Link>
      <div>
        <h1 className="text-2xl font-semibold">httpSMS setup</h1>
        <p className="text-sm text-muted mt-1">Project: <a className="text-accent" href="https://github.com/NdoleStudio/httpsms">github.com/NdoleStudio/httpsms</a></p>
      </div>

      <StepGuide steps={STEPS} />

      <div className="card space-y-2">
        <div className="font-medium">Common problems</div>
        <ul className="text-sm text-muted list-disc list-inside space-y-1">
          <li><strong>Invalid credentials</strong> — the API key is wrong or was revoked. Generate a new one and update the gateway here.</li>
          <li><strong>No phone matching this number</strong> — the phone number entered here doesn't exactly match what's registered on the httpSMS account (check formatting, e.g. missing country code).</li>
          <li><strong>Provider unavailable / network error / timeout</strong> — httpSMS's own API is unreachable right now, not a problem with your key or phone. Try again shortly.</li>
        </ul>
      </div>

      <p className="text-xs text-warn">Never paste a real API key into a document, ticket, or chat when asking for help — use YOUR_API_KEY as a placeholder and let the person helping you re-enter the real one directly.</p>

      <VerifiedSource
        verifiedOn="September 8, 2026"
        sources={[{ label: 'NdoleStudio/httpsms (GitHub)', href: 'https://github.com/NdoleStudio/httpsms' }]}
      />
    </div>
  );
}
