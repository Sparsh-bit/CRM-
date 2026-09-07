import { redirect, notFound } from 'next/navigation';
import Link from 'next/link';
import { getSession } from '@/lib/session';
import { getAgent } from '@/lib/agents/agents';
import { listTasks } from '@/lib/agents/tasks';
import { listApprovals } from '@/lib/agents/approvals';
import { listActivity } from '@/lib/agents/activity';
import { pillClass, agentStatusMeta, AUTONOMY_META, TASK_STATUS_META, APPROVAL_STATE_META } from '../../_lib/status';

export const dynamic = 'force-dynamic';

export default async function AgentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const s = await getSession();
  if (!s) redirect('/login');
  const { id } = await params;

  const agent = await getAgent(s.workspaceId, id);
  if (!agent) notFound();

  const [tasks, approvals, activity] = await Promise.all([
    listTasks(s.workspaceId, { agentId: id }),
    listApprovals(s.workspaceId, { agentId: id }),
    listActivity(s.workspaceId, { agentId: id }),
  ]);

  return (
    <div className="space-y-8">
      <div className="card space-y-3">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-line flex items-center justify-center text-sm font-semibold shrink-0">
                {agent.name.slice(0, 2).toUpperCase()}
              </div>
              <div>
                <div className="text-lg font-semibold">{agent.name}</div>
                <div className="text-sm text-muted">{agent.role}{agent.department ? ` · ${agent.department}` : ''}</div>
              </div>
            </div>
          </div>
          <div className="flex gap-2 shrink-0">
            <span className={pillClass(agentStatusMeta(agent.status).tone)}>{agentStatusMeta(agent.status).label}</span>
            <span className={pillClass(AUTONOMY_META[agent.autonomyLevel].tone)}>{AUTONOMY_META[agent.autonomyLevel].label}</span>
          </div>
        </div>
        {agent.objective && <p className="text-sm text-muted border-t border-line pt-3">{agent.objective}</p>}
      </div>

      <section className="space-y-3">
        <div className="font-medium">Tasks</div>
        <div className="card p-0 overflow-hidden overflow-x-auto">
          <table className="w-full">
            <thead className="bg-ink"><tr>{['Title', 'Priority', 'Status', 'Created'].map((h) => <th key={h} className="th">{h}</th>)}</tr></thead>
            <tbody>
              {tasks.map((t) => (
                <tr key={t.id}>
                  <td className="td">{t.title}</td>
                  <td className="td text-muted">{['Low', 'Normal', 'High', 'Urgent'][t.priority] ?? t.priority}</td>
                  <td className="td"><span className={pillClass(TASK_STATUS_META[t.status].tone)}>{TASK_STATUS_META[t.status].label}</span></td>
                  <td className="td text-muted">{t.createdAt.toLocaleDateString()}</td>
                </tr>
              ))}
              {!tasks.length && <tr><td className="td text-muted" colSpan={4}>Your workforce has no active tasks for this agent yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>

      <section className="space-y-3">
        <div className="font-medium">Approvals</div>
        <div className="card p-0 overflow-hidden overflow-x-auto">
          <table className="w-full">
            <thead className="bg-ink"><tr>{['Action', 'Status', 'Requested'].map((h) => <th key={h} className="th">{h}</th>)}</tr></thead>
            <tbody>
              {approvals.map((a) => (
                <tr key={a.id}>
                  <td className="td">{a.actionType}</td>
                  <td className="td"><span className={pillClass(APPROVAL_STATE_META[a.status].tone)}>{APPROVAL_STATE_META[a.status].label}</span></td>
                  <td className="td text-muted">{a.createdAt.toLocaleDateString()}</td>
                </tr>
              ))}
              {!approvals.length && <tr><td className="td text-muted" colSpan={3}>No approvals requested by this agent yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>

      <section className="space-y-3">
        <div className="font-medium">Activity</div>
        <div className="card">
          {activity.length ? (
            <ul className="space-y-3">
              {activity.map((e) => (
                <li key={e.id} className="text-sm border-t border-line pt-3 first:border-0 first:pt-0">
                  <span className="text-muted">{e.createdAt.toLocaleString()}</span> — {e.type}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted">Activity will appear here once the agent runtime is enabled and this agent begins working.</p>
          )}
        </div>
      </section>

      <section className="space-y-3">
        <div className="font-medium">Configuration</div>
        <div className="card grid md:grid-cols-2 gap-4 text-sm">
          <div><div className="label">Autonomy level</div>{AUTONOMY_META[agent.autonomyLevel].label}</div>
          <div><div className="label">Allowed tools</div>{Array.isArray(agent.allowedTools) && agent.allowedTools.length ? (agent.allowedTools as string[]).join(', ') : <span className="text-muted">None configured yet</span>}</div>
          {agent.instructions && <div className="md:col-span-2"><div className="label">Instructions</div><p className="text-muted whitespace-pre-wrap">{agent.instructions}</p></div>}
        </div>
      </section>

      <Link href="/workforce/agents" className="text-xs text-accent">← All agents</Link>
    </div>
  );
}
