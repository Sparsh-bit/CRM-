import { redirect } from 'next/navigation';
import Link from 'next/link';
import { getSession } from '@/lib/session';
import { db } from '@/lib/db';

export const dynamic = 'force-dynamic';

export default async function Dashboard() {
  const s = await getSession();
  if (!s) redirect('/login');
  const w = s.workspaceId;

  const [leads, campaigns, sent, opened, clicked, replied, queued, mailboxes, wa] = await Promise.all([
    db.lead.count({ where: { workspaceId: w } }),
    db.campaign.count({ where: { workspaceId: w } }),
    db.message.count({ where: { workspaceId: w, status: 'sent' } }),
    db.message.count({ where: { workspaceId: w, openedAt: { not: null } } }),
    db.message.count({ where: { workspaceId: w, clickedAt: { not: null } } }),
    db.message.count({ where: { workspaceId: w, repliedAt: { not: null } } }),
    db.message.count({ where: { workspaceId: w, status: 'queued' } }),
    db.mailbox.count({ where: { workspaceId: w, status: 'active' } }),
    db.waInstance.count({ where: { workspaceId: w, status: 'connected' } }),
  ]);

  const pct = (n: number) => (sent ? Math.round((n / sent) * 100) : 0);
  const stats: [string, string | number, string?][] = [
    ['Leads', leads], ['Campaigns', campaigns], ['Sent', sent], ['Queued', queued],
    ['Opened', `${opened}`, `${pct(opened)}%`], ['Clicked', `${clicked}`, `${pct(clicked)}%`],
    ['Replied', `${replied}`, `${pct(replied)}%`],
    ['Channels', `${mailboxes} inbox · ${wa} WA`],
  ];

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Dashboard</h1>
        <div className="flex gap-2">
          <Link href="/lists" className="btn-sec">Import a list</Link>
          <Link href="/campaigns" className="btn">New campaign</Link>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {stats.map(([label, value, sub]) => (
          <div key={label} className="card">
            <div className="text-xs text-muted">{label}</div>
            <div className="text-2xl font-semibold mt-1">{value}</div>
            {sub && <div className="text-xs text-muted mt-0.5">{sub} of sent</div>}
          </div>
        ))}
      </div>

      {sent === 0 && (
        <div className="card space-y-2">
          <div className="font-medium">Get to your first send in four steps</div>
          <ol className="text-sm text-muted list-decimal ml-5 space-y-1">
            <li><Link className="text-accent" href="/mailboxes">Connect a mailbox</Link> — SMTP, Resend, Gmail or Outlook.</li>
            <li><Link className="text-accent" href="/lists">Upload your lead sheet</Link> — every sheet and column is read automatically.</li>
            <li><Link className="text-accent" href="/campaigns">Create a campaign</Link> — write a template, or let the AI writer draft one per lead.</li>
            <li>Review the drafts, run preflight, then launch. Keep <code className="text-slate-300">npm run worker</code> running.</li>
          </ol>
        </div>
      )}
    </div>
  );
}
