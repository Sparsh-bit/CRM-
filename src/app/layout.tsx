import { ReticleDev } from './reticle-dev';
import './globals.css';
import Link from 'next/link';
import { Outfit, Public_Sans } from 'next/font/google';
import { getSession } from '@/lib/session';
import { db } from '@/lib/db';
import { NavBar } from './_components/NavBar';

export const metadata = { title: 'OutreachPilot', description: 'Bulk email + WhatsApp outreach with an AI writer' };

// Two-font system, not the Inter-everywhere default: Outfit for headings
// (confident, geometric — gives the app a real identity at a glance) and
// Public Sans for body/UI/data (built for legibility at small sizes, where
// this app spends most of its screen real estate — tables, metadata,
// dense stat tiles). Both self-hosted via next/font, zero layout shift,
// zero new npm dependency.
const displayFont = Outfit({ subsets: ['latin'], weight: ['500', '600', '700'], variable: '--font-display', display: 'swap' });
const bodyFont = Public_Sans({ subsets: ['latin'], weight: ['400', '500', '600', '700'], variable: '--font-body', display: 'swap' });

const NAV = [
  ['/', 'Dashboard'], ['/onboarding', 'Get Started'], ['/lists', 'Lists'], ['/campaigns', 'Campaigns'], ['/workforce', 'Workforce'],
  ['/mailboxes', 'Mailboxes'], ['/whatsapp', 'WhatsApp'], ['/sms', 'SMS'], ['/usage', 'Usage'], ['/help', 'Help'], ['/settings', 'Settings'],
];

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  const ws = session ? await db.workspace.findUnique({ where: { id: session.workspaceId } }) : null;

  return (
    <html lang="en" className={`${displayFont.variable} ${bodyFont.variable}`}>
      <body>{process.env.NODE_ENV === 'development' ? <ReticleDev /> : null}
        {session && (
          <header className="border-b border-line bg-panel relative">
            <div className="max-w-6xl mx-auto px-4 sm:px-6 h-14 flex items-center gap-4 sm:gap-6">
              <Link href="/" className="font-display font-semibold tracking-tight shrink-0 text-slate-100">
                OutreachPilot
              </Link>
              <NavBar items={NAV as [string, string][]} />
              <div className="ml-auto flex items-center gap-3 shrink-0">
                <div className="hidden sm:block text-secondary">{ws?.name}</div>
                <form action="/api/auth/logout" method="post">
                  <button className="text-xs text-muted hover:text-slate-100 transition-colors">Sign out</button>
                </form>
              </div>
            </div>
          </header>
        )}
        <main className="max-w-6xl mx-auto px-4 sm:px-6 py-6 sm:py-8">{children}</main>
      </body>
    </html>
  );
}
