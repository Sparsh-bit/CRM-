import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/session';

export const dynamic = 'force-dynamic';

const SECTIONS = [
  { href: '/help/email', title: 'Email', description: 'Connect an SMTP mailbox (Gmail App Password), Resend, or an OAuth inbox — and read what a failed test actually means.' },
  { href: '/help/whatsapp', title: 'WhatsApp', description: 'What Evolution API is, how to connect a number, and how to tell "CRM down" apart from "phone unpaired".' },
  { href: '/help/sms', title: 'SMS', description: 'How httpSMS turns your own Android phone into a gateway, and what "Test connection" can and can\'t confirm.' },
];

export default async function HelpIndex() {
  const s = await getSession();
  if (!s) redirect('/login');

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold">Setup &amp; help</h1>
        <p className="text-sm text-muted mt-1">Provider-by-provider setup guides — where credentials come from, how to test a connection, and what each error means.</p>
      </div>

      <div className="grid md:grid-cols-3 gap-4">
        {SECTIONS.map((s) => (
          <Link key={s.href} href={s.href} className="card block hover:border-accent transition">
            <div className="font-medium">{s.title}</div>
            <p className="text-sm text-muted mt-1">{s.description}</p>
          </Link>
        ))}
      </div>
    </div>
  );
}
