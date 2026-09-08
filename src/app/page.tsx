import { redirect } from 'next/navigation';
import Link from 'next/link';
import { getSession } from '@/lib/session';
import { db } from '@/lib/db';

export const dynamic = 'force-dynamic';

export default async function Dashboard() {
  const s = await getSession();
  if (!s) redirect('/landing');
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
  const pipeline: [string, number][] = [['Leads', leads], ['Campaigns', campaigns]];
  const engagement: [string, number, string][] = [
    ['Sent', sent, ''], ['Queued', queued, ''],
    ['Opened', opened, `${pct(opened)}% of sent`],
    ['Clicked', clicked, `${pct(clicked)}% of sent`],
    ['Replied', replied, `${pct(replied)}% of sent`],
  ];

  return (
    <div className="space-y-8">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Dashboard</h1>
          <p className="text-sm text-muted mt-1">Real-time counts from your workspace.</p>
        </div>
        <div className="flex gap-2">
          <Link href="/lists" className="btn-sec">Import a list</Link>
          <Link href="/campaigns" className="btn">New campaign</Link>
        </div>
      </div>

      <div className="grid sm:grid-cols-2 gap-4">
        {pipeline.map(([label, value]) => (
          <div key={label} className="card">
            <div className="text-xs text-muted">{label}</div>
            <div className="text-3xl font-semibold mt-1">{value}</div>
          </div>
        ))}
      </div>

      <div className="space-y-3">
        <div className="text-xs uppercase tracking-wide text-muted font-semibold">Engagement</div>
        <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
          {engagement.map(([label, value, sub]) => (
            <div key={label} className="card">
              <div className="text-xs text-muted">{label}</div>
              <div className="text-2xl font-semibold mt-1">{value}</div>
              {sub && <div className="text-xs text-muted mt-0.5">{sub}</div>}
            </div>
          ))}
        </div>
      </div>

      <div className="card flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <div className="text-sm font-medium">Channels connected</div>
          <div className="text-xs text-muted mt-0.5">{mailboxes} mailbox{mailboxes === 1 ? '' : 'es'} active, {wa} WhatsApp instance{wa === 1 ? '' : 's'} connected.</div>
        </div>
        <Link href="/mailboxes" className="btn-sec text-xs shrink-0">Manage channels</Link>
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
