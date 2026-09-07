import { redirect } from 'next/navigation';
import Link from 'next/link';
import { db } from '@/lib/db';
import { getSession } from '@/lib/session';
import { TaskStatus, ApprovalState } from '@/generated/prisma/enums';
import { pillClass, agentStatusMeta } from './_lib/status';

export const dynamic = 'force-dynamic';

const ACTIVE_STATUSES: TaskStatus[] = [
  TaskStatus.Queued, TaskStatus.Thinking, TaskStatus.Working,
  TaskStatus.WaitingForInput, TaskStatus.WaitingForApproval,
];

export default async function WorkforceOverview() {
  const s = await getSession();
  if (!s) redirect('/login');
  const w = s.workspaceId;

  const [agentCount, activeTaskCount, completedTaskCount, pendingApprovals, failedTasks, agents] = await Promise.all([
    db.agent.count({ where: { workspaceId: w } }),
    db.agentTask.count({ where: { workspaceId: w, status: { in: ACTIVE_STATUSES } } }),
    db.agentTask.count({ where: { workspaceId: w, status: TaskStatus.Completed } }),
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
      include: { _count: { select: { tasks: true, approvals: true } } },
    }),
  ]);

  if (agentCount === 0) {
    return (
      <div className="card text-center py-16 space-y-3">
        <div className="text-lg font-medium">No AI employees yet</div>
        <p className="text-sm text-muted max-w-md mx-auto">Your digital workforce is ready to be configured. Add an agent, give it a role and an autonomy level, and assign its first task.</p>
        <Link href="/workforce/agents" className="btn inline-flex mt-2">Create your first employee</Link>
      </div>
    );
  }

  const pendingApprovalCount = await db.approval.count({ where: { workspaceId: w, status: ApprovalState.Pending } });

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          ['Agents', agentCount],
          ['Active tasks', activeTaskCount],
          ['Pending approvals', pendingApprovalCount],
          ['Completed tasks', completedTaskCount],
        ].map(([label, value]) => (
          <div key={label} className="card">
            <div className="text-xs text-muted">{label}</div>
            <div className="text-2xl font-semibold mt-1">{value}</div>
          </div>
        ))}
      </div>

      <div className="grid lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 card space-y-4">
          <div className="font-medium">Needs attention</div>
          {pendingApprovals.length === 0 && failedTasks.length === 0 && (
            <p className="text-sm text-muted">Nothing waiting on you. Your workforce has no pending approvals or failures right now.</p>
          )}
          {pendingApprovals.map((a) => (
            <div key={a.id} className="flex items-start justify-between gap-4 border-t border-line pt-3 first:border-0 first:pt-0">
              <div>
                <div className="text-sm font-medium">{a.task.title}</div>
                <div className="text-xs text-muted mt-0.5">{a.agent.name} · {a.actionType} · needs approval</div>
              </div>
              <Link href={`/workforce/approvals`} className="btn-sec text-xs shrink-0">Review</Link>
            </div>
          ))}
          {failedTasks.map((t) => (
            <div key={t.id} className="flex items-start justify-between gap-4 border-t border-line pt-3 first:border-0 first:pt-0">
              <div>
                <div className="text-sm font-medium">{t.title}</div>
                <div className="text-xs text-muted mt-0.5">{t.agent.name} · failed{t.failureReason ? ` · ${t.failureReason}` : ''}</div>
              </div>
              <span className={pillClass('bad')}>Failed</span>
            </div>
          ))}
        </div>

        <div className="card space-y-4">
          <div className="font-medium">Agents</div>
          <div className="space-y-3">
            {agents.map((a) => (
              <Link key={a.id} href={`/workforce/agents/${a.id}`} className="flex items-center justify-between gap-3 group">
                <div className="min-w-0">
                  <div className="text-sm group-hover:text-accent truncate">{a.name}</div>
                  <div className="text-xs text-muted truncate">{a.role}</div>
                </div>
                <span className={`${pillClass(agentStatusMeta(a.status).tone)} shrink-0`}>{agentStatusMeta(a.status).label}</span>
              </Link>
            ))}
          </div>
          <Link href="/workforce/agents" className="text-xs text-accent">View all agents →</Link>
        </div>
      </div>
    </div>
  );
}
