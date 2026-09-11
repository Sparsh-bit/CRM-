import { redirect } from 'next/navigation';
import Link from 'next/link';
import { getSession } from '@/lib/session';
import { db } from '@/lib/db';
import { ApprovalState, TaskStatus } from '@/generated/prisma/enums';
import { ACTIVE_TASK_STATUSES } from './workforce/_lib/status';
import { getUsageSummary } from '@/lib/usage/service';
import { PageHeader } from '@/components/PageHeader';
import { Button } from '@/components/Button';
import { Card } from '@/components/Card';

export const dynamic = 'force-dynamic';

function greeting(): string {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

/** AgentActivityLog.type is a free-form snake_case string (task_created, approval_approved, ...) — reformatted for reading, never reworded into something it didn't say. */
function humanizeActivity(type: string): string {
  return type.replace(/_/g, ' ');
}

export default async function Dashboard() {
  const s = await getSession();
  if (!s) redirect('/landing');
  const w = s.workspaceId;

  const [
    leads, campaigns, sent, opened, clicked, replied, queued, mailboxes, wa,
    activeTasks, pendingApprovals, failedTasks, pendingApprovalList, failedTaskList,
    usage, recentActivity,
  ] = await Promise.all([
    db.lead.count({ where: { workspaceId: w } }),
    db.campaign.count({ where: { workspaceId: w } }),
    db.message.count({ where: { workspaceId: w, status: 'sent' } }),
    db.message.count({ where: { workspaceId: w, openedAt: { not: null } } }),
    db.message.count({ where: { workspaceId: w, clickedAt: { not: null } } }),
    db.message.count({ where: { workspaceId: w, repliedAt: { not: null } } }),
    db.message.count({ where: { workspaceId: w, status: 'queued' } }),
    db.mailbox.count({ where: { workspaceId: w, status: 'active' } }),
    db.waInstance.count({ where: { workspaceId: w, status: 'connected' } }),
    db.agentTask.count({ where: { workspaceId: w, status: { in: ACTIVE_TASK_STATUSES } } }),
    db.approval.count({ where: { workspaceId: w, status: ApprovalState.Pending } }),
    db.agentTask.count({ where: { workspaceId: w, status: TaskStatus.Failed } }),
    db.approval.findMany({
      where: { workspaceId: w, status: ApprovalState.Pending }, orderBy: { createdAt: 'asc' }, take: 3,
      include: { agent: true, task: true },
    }),
    db.agentTask.findMany({
      where: { workspaceId: w, status: TaskStatus.Failed }, orderBy: { updatedAt: 'desc' }, take: 3,
      include: { agent: true },
    }),
    getUsageSummary(w),
    db.agentActivityLog.findMany({
      where: { workspaceId: w }, orderBy: { createdAt: 'desc' }, take: 8,
      include: { agent: true },
    }),
  ]);

  const pct = (n: number) => (sent ? Math.round((n / sent) * 100) : 0);
  const needsAttention = pendingApprovals + failedTasks;
  const messageUsage = usage.counters.message;

  const hero: Array<[string, number, 'accent' | 'warn' | undefined, string]> = [
    ['Leads', leads, undefined, '/lists'],
    ['Campaigns', campaigns, undefined, '/campaigns'],
    ['Active tasks', activeTasks, activeTasks > 0 ? 'accent' : undefined, '/workforce/tasks'],
    ['Approvals', pendingApprovals, pendingApprovals > 0 ? 'warn' : undefined, '/workforce/approvals'],
  ];
  const engagement: Array<[string, number, string?]> = [
    ['Sent', sent], ['Queued', queued],
    ['Opened', opened, `${pct(opened)}%`], ['Clicked', clicked, `${pct(clicked)}%`], ['Replied', replied, `${pct(replied)}%`],
  ];

  return (
    <div className="space-y-10">
      <PageHeader
        title={greeting()}
        description="Here's what's happening across your workspace."
        actions={
          <>
            <Button href="/lists" variant="secondary">Import a list</Button>
            <Button href="/campaigns">New campaign</Button>
          </>
        }
      />

      {/* Hero metrics — open, divided by rule lines, not four boxed tiles */}
      <div className="flex flex-wrap gap-x-10 gap-y-5">
        {hero.map(([label, value, tone, href], i) => (
          <Link key={label} href={href} className={`group min-w-[6rem] ${i > 0 ? 'sm:border-l sm:border-line sm:pl-10' : ''}`}>
            <div className="text-meta">{label}</div>
            <div className={`metric mt-1.5 group-hover:opacity-80 transition ${tone === 'accent' ? 'text-accent' : tone === 'warn' ? 'text-warn' : ''}`}>{value}</div>
          </Link>
        ))}
      </div>

      <div className="grid lg:grid-cols-3 gap-8">
        {/* Large left area: real workforce activity, not a boxed grid */}
        <div className="lg:col-span-2 space-y-3 min-w-0">
          <div className="text-meta">Workforce activity</div>
          {recentActivity.length ? (
            <div className="divide-y divide-line border-t border-line">
              {recentActivity.map((e) => (
                <div key={e.id} className="flex items-center justify-between gap-4 py-3">
                  <div className="min-w-0 text-sm truncate">
                    <span className="font-medium text-slate-100">{e.agent.name}</span>
                    <span className="text-muted"> · {humanizeActivity(e.type)}</span>
                  </div>
                  <div className="text-secondary shrink-0">{e.createdAt.toLocaleString()}</div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-secondary border-t border-line pt-4">
              No workforce activity yet. Once your agents start working, it shows up here.
            </p>
          )}
        </div>

        {/* Right rail: attention, channels, usage */}
        <div className="space-y-4 min-w-0">
          <Card className={needsAttention > 0 ? 'border-warn/40' : undefined}>
            <div className="flex items-center justify-between mb-1">
              <div className="card-heading text-sm">Needs your attention</div>
              {needsAttention > 0 && <span className="metric text-warn text-lg">{needsAttention}</span>}
            </div>
            {needsAttention === 0 ? (
              <p className="text-secondary">Nothing waiting on you right now.</p>
            ) : (
              <div className="space-y-3 mt-3">
                {pendingApprovalList.map((a) => (
                  <div key={a.id} className="flex items-start justify-between gap-3 border-t border-line pt-3 first:border-0 first:pt-0">
                    <div className="min-w-0">
                      <div className="text-sm font-medium truncate">{a.task.title}</div>
                      <div className="text-secondary mt-0.5 truncate">{a.agent.name} · needs approval</div>
                    </div>
                    <Button href="/workforce/approvals" variant="secondary" className="text-xs shrink-0">Review</Button>
                  </div>
                ))}
                {failedTaskList.map((t) => (
                  <div key={t.id} className="flex items-start justify-between gap-3 border-t border-line pt-3 first:border-0 first:pt-0">
                    <div className="min-w-0">
                      <div className="text-sm font-medium truncate">{t.title}</div>
                      <div className="text-secondary mt-0.5 truncate">{t.agent.name} · failed</div>
                    </div>
                    <Button href="/workforce/tasks" variant="secondary" className="text-xs shrink-0">View</Button>
                  </div>
                ))}
              </div>
            )}
          </Card>

          <Card className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="card-heading text-sm">Channels</span>
              <Link href="/mailboxes" className="text-xs text-accent hover:underline">Manage</Link>
            </div>
            <p className="text-secondary">{mailboxes} mailbox{mailboxes === 1 ? '' : 'es'} active, {wa} WhatsApp instance{wa === 1 ? '' : 's'} connected.</p>
          </Card>

          <Card className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="card-heading text-sm">Usage</span>
              <Link href="/usage" className="text-xs text-accent hover:underline">Details</Link>
            </div>
            <p className="text-secondary">
              {messageUsage ? `${messageUsage.used}${messageUsage.limit ? ` / ${messageUsage.limit}` : ''} messages` : 'No usage recorded yet'} · {usage.plan} plan
            </p>
          </Card>
        </div>
      </div>

      {/* Engagement — an open, divided row, not five boxed tiles */}
      <div className="space-y-3">
        <div className="text-meta">Outreach performance</div>
        <div className="flex flex-wrap gap-x-8 gap-y-4 border-t border-line pt-4">
          {engagement.map(([label, value, sub], i) => (
            <div key={label} className={i > 0 ? 'sm:border-l sm:border-line sm:pl-8' : ''}>
              <div className="text-meta">{label}</div>
              <div className="metric mt-1.5 text-xl md:text-2xl">{value}</div>
              {sub && <div className="text-secondary mt-0.5">{sub} of sent</div>}
            </div>
          ))}
        </div>
      </div>

      {sent === 0 && (
        <Card className="space-y-2">
          <div className="card-heading">Get to your first send in four steps</div>
          <ol className="text-sm text-muted list-decimal ml-5 space-y-1">
            <li><Link className="text-accent hover:underline" href="/mailboxes">Connect a mailbox</Link> — SMTP, Resend, Gmail or Outlook.</li>
            <li><Link className="text-accent hover:underline" href="/lists">Upload your lead sheet</Link> — every sheet and column is read automatically.</li>
            <li><Link className="text-accent hover:underline" href="/campaigns">Create a campaign</Link> — write a template, or let the AI writer draft one per lead.</li>
            <li>Review the drafts, run preflight, then launch. Keep <code className="text-slate-300">npm run worker</code> running.</li>
          </ol>
        </Card>
      )}
    </div>
  );
}
