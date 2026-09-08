import { ReticleDev } from './reticle-dev';
import './globals.css';
import Link from 'next/link';
import { getSession } from '@/lib/session';
import { db } from '@/lib/db';
import { NavBar } from './_components/NavBar';

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
          <header className="border-b border-line bg-panel relative">
            <div className="max-w-6xl mx-auto px-6 h-14 flex items-center gap-6">
              <Link href="/" className="font-semibold tracking-tight shrink-0">OutreachPilot</Link>
              <NavBar items={NAV as [string, string][]} />
              <div className="ml-auto flex items-center gap-3 shrink-0">
                <div className="hidden sm:block text-xs text-muted">{ws?.name}</div>
                <form action="/api/auth/logout" method="post">
                  <button className="text-xs text-muted hover:text-slate-200">Sign out</button>
                </form>
              </div>
            </div>
          </header>
        )}
        <main className="max-w-6xl mx-auto px-6 py-8">{children}</main>
      </body>
    </html>
  );
}
