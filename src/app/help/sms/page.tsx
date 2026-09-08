import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/session';

export const dynamic = 'force-dynamic';

export default async function SmsHelpIndex() {
  const s = await getSession();
  if (!s) redirect('/login');

  return (
    <div className="space-y-8">
      <Link href="/help" className="text-sm text-muted hover:text-slate-200">← Help</Link>
      <div>
        <h1 className="text-2xl font-semibold">SMS setup</h1>
        <p className="text-sm text-muted mt-1">
          The only SMS provider implemented is <a className="text-accent" href="https://httpsms.com">httpSMS</a> — it turns
          your own Android phone and SIM into the sending device, reached over your phone's normal internet connection.
          There is no separate telecom account to buy; you're using your existing number and plan.
          <Link href="/help/sms/httpsms" className="text-accent"> Full setup guide →</Link>
        </p>
      </div>

      <div className="card space-y-2">
        <div className="font-medium">What "Test connection" can and can't confirm</div>
        <p className="text-sm text-muted">
          httpSMS's API doesn't expose a live "is the phone online right now" flag — that's tracked on-device via a
          background service, not returned to API callers. A successful test here confirms the API key is valid and
          the phone number is registered on the account; it does not guarantee the phone is online at this exact moment.
        </p>
      </div>

    </div>
  );
}
