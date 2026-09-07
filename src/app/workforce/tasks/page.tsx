import { redirect } from 'next/navigation';
import Link from 'next/link';
import { db } from '@/lib/db';
import { getSession } from '@/lib/session';
import { TaskStatus } from '@/generated/prisma/enums';
import { pillClass, TASK_STATUS_META } from '../_lib/status';

export const dynamic = 'force-dynamic';

const PRIORITY_LABEL = ['Low', 'Normal', 'High', 'Urgent'];
const FILTERS: Array<{ label: string; statuses?: TaskStatus[] }> = [
  { label: 'All' },
  { label: 'Active', statuses: [TaskStatus.Queued, TaskStatus.Thinking, TaskStatus.Working, TaskStatus.WaitingForInput, TaskStatus.WaitingForApproval] },
  { label: 'Completed', statuses: [TaskStatus.Completed] },
  { label: 'Failed', statuses: [TaskStatus.Failed] },
];

export default async function TasksPage({ searchParams }: { searchParams: Promise<{ filter?: string }> }) {
  const s = await getSession();
  if (!s) redirect('/login');
  const { filter } = await searchParams;
  const active = FILTERS.find((f) => f.label.toLowerCase() === filter) ?? FILTERS[0];

  const tasks = await db.agentTask.findMany({
    where: { workspaceId: s.workspaceId, ...(active.statuses ? { status: { in: active.statuses } } : {}) },
    orderBy: { createdAt: 'desc' },
    include: { agent: true },
  });

  return (
    <div className="space-y-6">
      <div className="flex gap-1 text-sm">
        {FILTERS.map((f) => (
          <Link
            key={f.label}
            href={f.label === 'All' ? '/workforce/tasks' : `/workforce/tasks?filter=${f.label.toLowerCase()}`}
            className={`px-3 py-1.5 rounded-md ${active.label === f.label ? 'bg-line text-slate-100' : 'text-muted hover:text-slate-200 hover:bg-line'}`}
          >
            {f.label}
          </Link>
        ))}
      </div>

      <div className="card p-0 overflow-hidden overflow-x-auto">
        <table className="w-full">
          <thead className="bg-ink"><tr>{['Task', 'Agent', 'Priority', 'Status', 'Created'].map((h) => <th key={h} className="th">{h}</th>)}</tr></thead>
          <tbody>
            {tasks.map((t) => (
              <tr key={t.id}>
                <td className="td">
                  <Link className="text-accent" href={`/workforce/agents/${t.agentId}`}>{t.title}</Link>
                  {t.description && <div className="text-xs text-muted mt-0.5">{t.description}</div>}
                </td>
                <td className="td text-muted">{t.agent.name}</td>
                <td className="td text-muted">{PRIORITY_LABEL[t.priority] ?? t.priority}</td>
                <td className="td"><span className={pillClass(TASK_STATUS_META[t.status].tone)}>{TASK_STATUS_META[t.status].label}</span></td>
                <td className="td text-muted">{t.createdAt.toLocaleDateString()}</td>
              </tr>
            ))}
            {!tasks.length && <tr><td className="td text-muted" colSpan={5}>Your workforce has no tasks here yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
