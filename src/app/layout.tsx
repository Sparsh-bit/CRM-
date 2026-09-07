import { ReticleDev } from './reticle-dev';
import './globals.css';
import Link from 'next/link';
import { getSession } from '@/lib/session';
import { db } from '@/lib/db';

export const metadata = { title: 'OutreachPilot', description: 'Bulk email + WhatsApp outreach with an AI writer' };

const NAV = [
  ['/', 'Dashboard'], ['/onboarding', 'Get Started'], ['/lists', 'Lists'], ['/campaigns', 'Campaigns'], ['/workforce', 'Workforce'],
  ['/mailboxes', 'Mailboxes'], ['/whatsapp', 'WhatsApp'], ['/sms', 'SMS'], ['/usage', 'Usage'], ['/settings', 'Settings'],
];

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  const ws = session ? await db.workspace.findUnique({ where: { id: session.workspaceId } }) : null;

  return (
    <html lang="en">
      <body>{process.env.NODE_ENV === 'development' ? <ReticleDev /> : null}
        {session && (
          <header className="border-b border-line bg-panel">
            <div className="max-w-6xl mx-auto px-6 h-14 flex items-center gap-6">
              <Link href="/" className="font-semibold tracking-tight">OutreachPilot</Link>
              <nav className="flex gap-1 text-sm">
                {NAV.map(([href, label]) => (
                  <Link key={href} href={href} className="px-3 py-1.5 rounded-md text-muted hover:text-slate-100 hover:bg-line">{label}</Link>
                ))}
              </nav>
              <div className="ml-auto text-xs text-muted">{ws?.name}</div>
              <form action="/api/auth/logout" method="post">
                <button className="text-xs text-muted hover:text-slate-200">Sign out</button>
              </form>
            </div>
          </header>
        )}
        <main className="max-w-6xl mx-auto px-6 py-8">{children}</main>
      </body>
    </html>
  );
}
