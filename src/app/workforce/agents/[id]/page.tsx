import { redirect, notFound } from 'next/navigation';
import Link from 'next/link';
import { getSession, requireSession, currentRole } from '@/lib/session';
import { getAgent, updateAgent } from '@/lib/agents/agents';
import { listTasks } from '@/lib/agents/tasks';
import { listApprovals } from '@/lib/agents/approvals';
import { listActivity } from '@/lib/agents/activity';
import { AutonomyLevel } from '@/generated/prisma/enums';
import { pillClass, agentStatusMeta, AUTONOMY_META, TASK_STATUS_META, APPROVAL_STATE_META } from '../../_lib/status';

export const dynamic = 'force-dynamic';

async function save(agentId: string, formData: FormData) {
  'use server';
  const session = await requireSession();
  const role = await currentRole();
  if (!role) throw new Error('You are not a member of this workspace.');

  await updateAgent({ workspaceId: session.workspaceId, role }, agentId, {
    name: String(formData.get('name') || ''),
    role: String(formData.get('title') || ''),
    department: String(formData.get('department') || '') || null,
    objective: String(formData.get('objective') || '') || null,
    instructions: String(formData.get('instructions') || '') || null,
    autonomyLevel: String(formData.get('autonomyLevel') || AutonomyLevel.SuggestOnly),
  });
}

async function toggleArchive(agentId: string, nextStatus: string) {
  'use server';
  const session = await requireSession();
  const role = await currentRole();
  if (!role) throw new Error('You are not a member of this workspace.');
  await updateAgent({ workspaceId: session.workspaceId, role }, agentId, { status: nextStatus });
}

export default async function AgentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const s = await getSession();
  if (!s) redirect('/login');
  const { id } = await params;

  const agent = await getAgent(s.workspaceId, id);
  if (!agent) notFound();

  const saveAction = save.bind(null, id);
  const archiveAction = toggleArchive.bind(null, id, agent.status === 'archived' ? 'active' : 'archived');

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
          <div className="flex items-center gap-2 shrink-0">
            <span className={pillClass(agentStatusMeta(agent.status).tone)}>{agentStatusMeta(agent.status).label}</span>
            <span className={pillClass(AUTONOMY_META[agent.autonomyLevel].tone)}>{AUTONOMY_META[agent.autonomyLevel].label}</span>
            <form action={archiveAction}>
              <button className="btn-sec text-xs">{agent.status === 'archived' ? 'Reactivate' : 'Archive'}</button>
            </form>
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
        <form action={saveAction} className="card space-y-4">
          <div className="grid md:grid-cols-2 gap-4">
            <div><label className="label">Name</label><input className="input" name="name" defaultValue={agent.name} required /></div>
            <div><label className="label">Role / title</label><input className="input" name="title" defaultValue={agent.role} required /></div>
            <div><label className="label">Department</label><input className="input" name="department" defaultValue={agent.department ?? ''} /></div>
            <div>
              <label className="label">Autonomy</label>
              <select className="input" name="autonomyLevel" defaultValue={agent.autonomyLevel}>
                {Object.values(AutonomyLevel).map((v) => (
                  <option key={v} value={v}>{AUTONOMY_META[v].label}</option>
                ))}
              </select>
            </div>
          </div>
          <div><label className="label">Objective</label><textarea className="input h-20" name="objective" defaultValue={agent.objective ?? ''} /></div>
          <div><label className="label">Instructions</label><textarea className="input h-24" name="instructions" defaultValue={agent.instructions ?? ''} placeholder="The system prompt this agent works from." /></div>
          <div>
            <div className="label">Allowed tools</div>
            <div className="text-sm text-muted">{Array.isArray(agent.allowedTools) && agent.allowedTools.length ? (agent.allowedTools as string[]).join(', ') : 'None configured yet'}</div>
          </div>
          <button className="btn">Save changes</button>
        </form>
      </section>

      <Link href="/workforce/agents" className="text-xs text-accent">← All agents</Link>
    </div>
  );
}
