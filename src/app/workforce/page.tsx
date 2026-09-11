import { redirect } from 'next/navigation';
import Link from 'next/link';
import { db } from '@/lib/db';
import { getSession } from '@/lib/session';
import { TaskStatus, ApprovalState } from '@/generated/prisma/enums';
import { agentStatusMeta, ACTIVE_TASK_STATUSES } from './_lib/status';
import { Badge } from '@/components/Badge';
import { Button } from '@/components/Button';

export const dynamic = 'force-dynamic';

export default async function WorkforceOverview() {
  const s = await getSession();
  if (!s) redirect('/login');
  const w = s.workspaceId;

  const [agentCount, activeTaskCount, completedTaskCount, pendingApprovalCount, pendingApprovals, failedTasks, recentlyCompleted, agents] = await Promise.all([
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
    db.agentTask.findMany({
      where: { workspaceId: w, status: TaskStatus.Completed }, orderBy: { updatedAt: 'desc' }, take: 4,
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
  const hero: Array<[string, number, 'accent' | 'warn' | 'good' | undefined, string]> = [
    ['Agents', agentCount, undefined, '/workforce/agents'],
    ['Active tasks', activeTaskCount, activeTaskCount > 0 ? 'accent' : undefined, '/workforce/tasks'],
    ['Pending approvals', pendingApprovalCount, pendingApprovalCount > 0 ? 'warn' : undefined, '/workforce/approvals'],
    ['Completed tasks', completedTaskCount, 'good', '/workforce/tasks'],
  ];
  const TONE_CLASS: Record<string, string> = { accent: 'text-accent', warn: 'text-warn', good: 'text-good' };

  return (
    <div className="space-y-8">
      {/* Open metric strip, not four boxed tiles */}
      <div className="flex flex-wrap gap-x-10 gap-y-5">
        {hero.map(([label, value, tone, href], i) => (
          <Link key={label} href={href} className={`group min-w-[6rem] ${i > 0 ? 'sm:border-l sm:border-line sm:pl-10' : ''}`}>
            <div className="text-meta">{label}</div>
            <div className={`metric mt-1.5 group-hover:opacity-80 transition ${tone ? TONE_CLASS[tone] : ''}`}>{value}</div>
          </Link>
        ))}
      </div>

      <div className="grid lg:grid-cols-3 gap-8">
        <div className="lg:col-span-2 space-y-8 min-w-0">
          <section className="space-y-3">
            <div className="flex items-center justify-between">
              <div className="text-meta">Needs attention</div>
              {needsAttention > 0 && <Badge label={String(needsAttention)} tone="warn" />}
            </div>
            {needsAttention === 0 ? (
              <p className="text-secondary border-t border-line pt-4">Nothing waiting on you. No pending approvals or failures right now.</p>
            ) : (
              <div className="divide-y divide-line border-t border-line">
                {pendingApprovals.map((a) => (
                  <div key={a.id} className="flex items-start justify-between gap-4 py-3">
                    <div className="min-w-0">
                      <div className="text-sm font-medium truncate">{a.task.title}</div>
                      <div className="text-secondary mt-0.5">{a.agent.name} · {a.actionType} · needs approval</div>
                    </div>
                    <Button href="/workforce/approvals" variant="secondary" className="text-xs shrink-0">Review</Button>
                  </div>
                ))}
                {failedTasks.map((t) => (
                  <div key={t.id} className="flex items-start justify-between gap-4 py-3">
                    <div className="min-w-0">
                      <div className="text-sm font-medium truncate">{t.title}</div>
                      <div className="text-secondary mt-0.5">{t.agent.name} · failed{t.failureReason ? ` · ${t.failureReason}` : ''}</div>
                    </div>
                    <Badge label="Failed" tone="bad" className="shrink-0" />
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="space-y-3">
            <div className="text-meta">Recently finished</div>
            {recentlyCompleted.length ? (
              <div className="divide-y divide-line border-t border-line">
                {recentlyCompleted.map((t) => (
                  <div key={t.id} className="flex items-center justify-between gap-4 py-3">
                    <div className="min-w-0 text-sm truncate">
                      <span className="font-medium text-slate-100">{t.title}</span>
                      <span className="text-muted"> · {t.agent.name}</span>
                    </div>
                    <div className="text-secondary shrink-0">{t.updatedAt.toLocaleDateString()}</div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-secondary border-t border-line pt-4">Nothing completed yet.</p>
            )}
          </section>
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
