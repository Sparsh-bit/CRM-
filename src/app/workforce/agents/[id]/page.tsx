import { redirect, notFound } from 'next/navigation';
import Link from 'next/link';
import { getSession, requireSession, currentRole } from '@/lib/session';
import { getAgent, updateAgent } from '@/lib/agents/agents';
import { listTasks } from '@/lib/agents/tasks';
import { listApprovals } from '@/lib/agents/approvals';
import { listActivity } from '@/lib/agents/activity';
import { AutonomyLevel } from '@/generated/prisma/enums';
import { agentStatusMeta, AUTONOMY_META, TASK_STATUS_META, APPROVAL_STATE_META } from '../../_lib/status';
import { Card } from '@/components/Card';
import { Badge } from '@/components/Badge';
import { Button } from '@/components/Button';

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
  const tools = Array.isArray(agent.allowedTools) ? (agent.allowedTools as string[]) : [];

  const [tasks, approvals, activity] = await Promise.all([
    listTasks(s.workspaceId, { agentId: id }),
    listApprovals(s.workspaceId, { agentId: id }),
    listActivity(s.workspaceId, { agentId: id }),
  ]);

  return (
    <div className="space-y-6">
      <Link href="/workforce/agents" className="text-xs text-accent hover:underline">← All agents</Link>

      <Card className="space-y-3">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-3">
            <div className="w-11 h-11 rounded-lg bg-line flex items-center justify-center font-display font-semibold shrink-0">
              {agent.name.slice(0, 2).toUpperCase()}
            </div>
            <div>
              <div className="card-heading text-lg">{agent.name}</div>
              <div className="text-secondary">{agent.role}{agent.department ? ` · ${agent.department}` : ''}</div>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Badge {...agentStatusMeta(agent.status)} />
            <Badge {...AUTONOMY_META[agent.autonomyLevel]} />
            <form action={archiveAction}>
              <Button type="submit" variant="secondary" className="text-xs">{agent.status === 'archived' ? 'Reactivate' : 'Archive'}</Button>
            </form>
          </div>
        </div>
        {agent.objective && <p className="text-secondary border-t border-line pt-3">{agent.objective}</p>}
      </Card>

      {/* Activity & results (left, wider) vs. configuration (right) — kept
          visually separate rather than interleaved, per the brief: what this
          agent HAS DONE should never be mixed with what it's CONFIGURED to do. */}
      <div className="grid lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-6 min-w-0">
          <section className="space-y-3">
            <div className="text-meta">Tasks</div>
            <Card className="p-0 overflow-hidden overflow-x-auto">
              <table className="w-full">
                <thead className="bg-ink"><tr>{['Title', 'Priority', 'Status', 'Created'].map((h) => <th key={h} className="th">{h}</th>)}</tr></thead>
                <tbody>
                  {tasks.map((t) => (
                    <tr key={t.id}>
                      <td className="td">{t.title}</td>
                      <td className="td text-muted">{['Low', 'Normal', 'High', 'Urgent'][t.priority] ?? t.priority}</td>
                      <td className="td"><Badge {...TASK_STATUS_META[t.status]} /></td>
                      <td className="td text-muted">{t.createdAt.toLocaleDateString()}</td>
                    </tr>
                  ))}
                  {!tasks.length && <tr><td className="td text-muted" colSpan={4}>Your workforce has no tasks for this agent yet.</td></tr>}
                </tbody>
              </table>
            </Card>
          </section>

          <section className="space-y-3">
            <div className="text-meta">Approvals</div>
            <Card className="p-0 overflow-hidden overflow-x-auto">
              <table className="w-full">
                <thead className="bg-ink"><tr>{['Action', 'Status', 'Requested'].map((h) => <th key={h} className="th">{h}</th>)}</tr></thead>
                <tbody>
                  {approvals.map((a) => (
                    <tr key={a.id}>
                      <td className="td">{a.actionType}</td>
                      <td className="td"><Badge {...APPROVAL_STATE_META[a.status]} /></td>
                      <td className="td text-muted">{a.createdAt.toLocaleDateString()}</td>
                    </tr>
                  ))}
                  {!approvals.length && <tr><td className="td text-muted" colSpan={3}>No approvals requested by this agent yet.</td></tr>}
                </tbody>
              </table>
            </Card>
          </section>

          <section className="space-y-3">
            <div className="text-meta">Activity</div>
            <Card>
              {activity.length ? (
                <ul className="space-y-3">
                  {activity.map((e) => (
                    <li key={e.id} className="text-sm border-t border-line pt-3 first:border-0 first:pt-0">
                      <span className="text-muted">{e.createdAt.toLocaleString()}</span> — {e.type}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-secondary">Activity will appear here once this agent begins working.</p>
              )}
            </Card>
          </section>
        </div>

        <div className="space-y-3 min-w-0">
          <div className="text-meta">Configuration</div>
          <form action={saveAction} className="card space-y-4">
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
            <div><label className="label">Objective</label><textarea className="input h-20" name="objective" defaultValue={agent.objective ?? ''} /></div>
            <div><label className="label">Instructions</label><textarea className="input h-24" name="instructions" defaultValue={agent.instructions ?? ''} placeholder="The system prompt this agent works from." /></div>
            <div>
              <div className="label">Allowed tools</div>
              {tools.length ? (
                <div className="flex flex-wrap gap-1.5">
                  {tools.map((t) => <Badge key={t} label={t} tone="muted" />)}
                </div>
              ) : (
                <p className="text-secondary">None configured yet</p>
              )}
            </div>
            <Button type="submit" className="w-full justify-center">Save changes</Button>
          </form>
        </div>
      </div>
    </div>
  );
}
