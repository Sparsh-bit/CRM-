import { redirect } from 'next/navigation';
import Link from 'next/link';
import { db } from '@/lib/db';
import { getSession } from '@/lib/session';
import { TaskStatus, ApprovalState } from '@/generated/prisma/enums';
import { agentStatusMeta, ACTIVE_TASK_STATUSES } from './_lib/status';
import { StatTile } from '@/components/StatTile';
import { Badge } from '@/components/Badge';
import { Button } from '@/components/Button';

export const dynamic = 'force-dynamic';

export default async function WorkforceOverview() {
  const s = await getSession();
  if (!s) redirect('/login');
  const w = s.workspaceId;

  const [agentCount, activeTaskCount, completedTaskCount, pendingApprovalCount, pendingApprovals, failedTasks, agents] = await Promise.all([
    db.agent.count({ where: { workspaceId: w } }),
    db.agentTask.count({ where: { workspaceId: w, status: { in: ACTIVE_TASK_STATUSES } } }),
    db.agentTask.count({ where: { workspaceId: w, status: TaskStatus.Completed } }),
    db.approval.count({ where: { workspaceId: w, status: ApprovalState.Pending } }),
    db.approval.findMany({
      where: { workspaceId: w, status: ApprovalState.Pending }, orderBy: { createdAt: 'asc' }, take: 5,
      include: { agent: true, task: true },
    }),
    db.agentTask.findMany({
      where: { workspaceId: w, status: TaskStatus.Failed }, orderBy: { updatedAt: 'desc' }, take: 5,
      include: { agent: true },
    }),
    db.agent.findMany({
      where: { workspaceId: w }, orderBy: { createdAt: 'asc' },
      include: { _count: { select: { tasks: true } } },
    }),
  ]);

  if (agentCount === 0) {
    return (
      <div className="card text-center py-16 space-y-3">
        <div className="card-heading">No AI employees yet</div>
        <p className="text-secondary max-w-md mx-auto">Your digital workforce is ready to be configured. Add an agent, give it a role and an autonomy level, and assign its first task.</p>
        <Button href="/workforce/agents" className="inline-flex mt-2">Create your first employee</Button>
      </div>
    );
  }

  const needsAttention = pendingApprovals.length + failedTasks.length;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatTile label="Agents" value={agentCount} href="/workforce/agents" />
        <StatTile label="Active tasks" value={activeTaskCount} tone={activeTaskCount > 0 ? 'accent' : undefined} href="/workforce/tasks" />
        <StatTile label="Pending approvals" value={pendingApprovalCount} tone={pendingApprovalCount > 0 ? 'warn' : undefined} href="/workforce/approvals" />
        <StatTile label="Completed tasks" value={completedTaskCount} tone="good" href="/workforce/tasks" />
      </div>

      <div className="grid lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 card space-y-4 min-w-0">
          <div className="flex items-center justify-between">
            <div className="card-heading">Needs attention</div>
            {needsAttention > 0 && <Badge label={String(needsAttention)} tone="warn" />}
          </div>
          {needsAttention === 0 && (
            <p className="text-secondary">Nothing waiting on you. Your workforce has no pending approvals or failures right now.</p>
          )}
          {pendingApprovals.map((a) => (
            <div key={a.id} className="flex items-start justify-between gap-4 border-t border-line pt-3 first:border-0 first:pt-0">
              <div className="min-w-0">
                <div className="text-sm font-medium truncate">{a.task.title}</div>
                <div className="text-secondary mt-0.5">{a.agent.name} · {a.actionType} · needs approval</div>
              </div>
              <Button href="/workforce/approvals" variant="secondary" className="text-xs shrink-0">Review</Button>
            </div>
          ))}
          {failedTasks.map((t) => (
            <div key={t.id} className="flex items-start justify-between gap-4 border-t border-line pt-3 first:border-0 first:pt-0">
              <div className="min-w-0">
                <div className="text-sm font-medium truncate">{t.title}</div>
                <div className="text-secondary mt-0.5">{t.agent.name} · failed{t.failureReason ? ` · ${t.failureReason}` : ''}</div>
              </div>
              <Badge label="Failed" tone="bad" className="shrink-0" />
            </div>
          ))}
        </div>

        <div className="card space-y-4 min-w-0">
          <div className="card-heading">Team</div>
          <div className="space-y-1">
            {agents.map((a) => {
              const meta = agentStatusMeta(a.status);
              return (
                <Link key={a.id} href={`/workforce/agents/${a.id}`} className="flex items-center justify-between gap-3 group py-2 -mx-1 px-1 rounded-lg hover:bg-line/50 transition-colors">
                  <div className="min-w-0">
                    <div className="text-sm group-hover:text-accent truncate transition-colors">{a.name}</div>
                    <div className="text-secondary truncate">
                      {a.role}{a.department ? ` · ${a.department}` : ''} · {a._count.tasks} task{a._count.tasks === 1 ? '' : 's'}
                    </div>
                  </div>
                  <Badge {...meta} className="shrink-0" />
                </Link>
              );
            })}
          </div>
          <Link href="/workforce/agents" className="text-xs text-accent hover:underline inline-block">View all agents →</Link>
        </div>
      </div>
    </div>
  );
}
