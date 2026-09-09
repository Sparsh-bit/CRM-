import { redirect } from 'next/navigation';
import Link from 'next/link';
import { getSession } from '@/lib/session';
import { db } from '@/lib/db';
import { ApprovalState, TaskStatus } from '@/generated/prisma/enums';
import { ACTIVE_TASK_STATUSES } from './workforce/_lib/status';
import { getUsageSummary } from '@/lib/usage/service';
import { PageHeader } from '@/components/PageHeader';
import { StatTile } from '@/components/StatTile';
import { Button } from '@/components/Button';
import { Card } from '@/components/Card';

export const dynamic = 'force-dynamic';

export default async function Dashboard() {
  const s = await getSession();
  if (!s) redirect('/landing');
  const w = s.workspaceId;

  const [
    leads, campaigns, sent, opened, clicked, replied, queued, mailboxes, wa,
    activeTasks, pendingApprovals, failedTasks, pendingApprovalList, failedTaskList,
    usage,
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
  ]);

  const pct = (n: number) => (sent ? Math.round((n / sent) * 100) : 0);
  const needsAttention = pendingApprovals + failedTasks;
  const messageUsage = usage.counters.message;

  return (
    <div className="space-y-8">
      <PageHeader
        title="Dashboard"
        description="Real-time overview of your workspace."
        actions={
          <>
            <Button href="/lists" variant="secondary">Import a list</Button>
            <Button href="/campaigns">New campaign</Button>
          </>
        }
      />

      {/* Attention required — the one section that should draw the eye first */}
      <Card className={needsAttention > 0 ? 'border-warn/40' : undefined}>
        <div className="flex items-center justify-between mb-1">
          <div className="card-heading">Needs your attention</div>
          {needsAttention > 0 && <span className="metric text-warn text-lg">{needsAttention}</span>}
        </div>
        {needsAttention === 0 ? (
          <p className="text-secondary">Nothing waiting on you — no pending approvals or task failures right now.</p>
        ) : (
          <div className="space-y-3 mt-3">
            {pendingApprovalList.map((a) => (
              <div key={a.id} className="flex items-start justify-between gap-4 border-t border-line pt-3 first:border-0 first:pt-0">
                <div className="min-w-0">
                  <div className="text-sm font-medium truncate">{a.task.title}</div>
                  <div className="text-secondary mt-0.5">{a.agent.name} · {a.actionType} · needs approval</div>
                </div>
                <Button href="/workforce/approvals" variant="secondary" className="text-xs shrink-0">Review</Button>
              </div>
            ))}
            {failedTaskList.map((t) => (
              <div key={t.id} className="flex items-start justify-between gap-4 border-t border-line pt-3 first:border-0 first:pt-0">
                <div className="min-w-0">
                  <div className="text-sm font-medium truncate">{t.title}</div>
                  <div className="text-secondary mt-0.5">{t.agent.name} · failed{t.failureReason ? ` · ${t.failureReason}` : ''}</div>
                </div>
                <Button href="/workforce/tasks" variant="secondary" className="text-xs shrink-0">View</Button>
              </div>
            ))}
          </div>
        )}
      </Card>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatTile label="Leads" value={leads} href="/lists" />
        <StatTile label="Campaigns" value={campaigns} href="/campaigns" />
        <StatTile label="Workforce tasks" value={activeTasks} sub="active now" tone={activeTasks > 0 ? 'accent' : undefined} href="/workforce/tasks" />
        <StatTile label="Approvals" value={pendingApprovals} sub="waiting on you" tone={pendingApprovals > 0 ? 'warn' : undefined} href="/workforce/approvals" />
      </div>

      <div className="space-y-3">
        <div className="text-meta">Outreach performance</div>
        <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
          <StatTile label="Sent" value={sent} />
          <StatTile label="Queued" value={queued} />
          <StatTile label="Opened" value={opened} sub={`${pct(opened)}% of sent`} />
          <StatTile label="Clicked" value={clicked} sub={`${pct(clicked)}% of sent`} />
          <StatTile label="Replied" value={replied} sub={`${pct(replied)}% of sent`} tone={replied > 0 ? 'good' : undefined} />
        </div>
      </div>

      <div className="grid md:grid-cols-2 gap-4">
        <Card className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <div className="card-heading">Channels connected</div>
            <div className="text-secondary mt-0.5">{mailboxes} mailbox{mailboxes === 1 ? '' : 'es'} active, {wa} WhatsApp instance{wa === 1 ? '' : 's'} connected.</div>
          </div>
          <Button href="/mailboxes" variant="secondary" className="text-xs shrink-0">Manage channels</Button>
        </Card>

        <Card className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <div className="card-heading">Usage this period</div>
            <div className="text-secondary mt-0.5">
              {messageUsage ? `${messageUsage.used}${messageUsage.limit ? ` / ${messageUsage.limit}` : ''} messages sent` : 'No usage recorded yet'} · {usage.plan} plan
            </div>
          </div>
          <Button href="/usage" variant="secondary" className="text-xs shrink-0">View usage</Button>
        </Card>
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
