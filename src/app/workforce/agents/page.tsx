import { redirect } from 'next/navigation';
import Link from 'next/link';
import { db } from '@/lib/db';
import { getSession, requireSession, currentRole } from '@/lib/session';
import { createAgent } from '@/lib/agents/agents';
import { AutonomyLevel } from '@/generated/prisma/enums';
import { pillClass, agentStatusMeta, AUTONOMY_META } from '../_lib/status';

export const dynamic = 'force-dynamic';

async function create(formData: FormData) {
  'use server';
  const session = await requireSession();
  const role = await currentRole();
  if (!role) throw new Error('You are not a member of this workspace.');

  const agent = await createAgent({ workspaceId: session.workspaceId, role }, {
    name: String(formData.get('name') || ''),
    role: String(formData.get('title') || ''),
    department: String(formData.get('department') || '') || null,
    objective: String(formData.get('objective') || '') || null,
    autonomyLevel: String(formData.get('autonomyLevel') || AutonomyLevel.SuggestOnly),
  });
  redirect(`/workforce/agents/${agent.id}`);
}

export default async function AgentsPage() {
  const s = await getSession();
  if (!s) redirect('/login');

  const agents = await db.agent.findMany({
    where: { workspaceId: s.workspaceId }, orderBy: { createdAt: 'asc' },
    include: { _count: { select: { tasks: true, approvals: true } } },
  });

  return (
    <div className="space-y-8">
      <div className="card p-0 overflow-hidden overflow-x-auto">
        <table className="w-full">
          <thead className="bg-ink"><tr>{['Name', 'Role', 'Department', 'Autonomy', 'Tasks', 'Status'].map((h) => <th key={h} className="th">{h}</th>)}</tr></thead>
          <tbody>
            {agents.map((a) => (
              <tr key={a.id}>
                <td className="td"><Link className="text-accent" href={`/workforce/agents/${a.id}`}>{a.name}</Link></td>
                <td className="td text-muted">{a.role}</td>
                <td className="td text-muted">{a.department || '—'}</td>
                <td className="td"><span className={pillClass(AUTONOMY_META[a.autonomyLevel].tone)}>{AUTONOMY_META[a.autonomyLevel].label}</span></td>
                <td className="td">{a._count.tasks}</td>
                <td className="td"><span className={pillClass(agentStatusMeta(a.status).tone)}>{agentStatusMeta(a.status).label}</span></td>
              </tr>
            ))}
            {!agents.length && <tr><td className="td text-muted" colSpan={6}>No AI employees yet.</td></tr>}
          </tbody>
        </table>
      </div>

      <form action={create} className="card space-y-4 max-w-2xl">
        <div className="font-medium">New AI employee</div>
        <div className="grid md:grid-cols-2 gap-4">
          <div><label className="label">Name</label><input className="input" name="name" placeholder="Sales Agent" required /></div>
          <div><label className="label">Role / title</label><input className="input" name="title" placeholder="Lead Qualification" required /></div>
          <div><label className="label">Department</label><input className="input" name="department" placeholder="Sales" /></div>
          <div>
            <label className="label">Autonomy</label>
            <select className="input" name="autonomyLevel" defaultValue={AutonomyLevel.SuggestOnly}>
              {Object.values(AutonomyLevel).map((v) => (
                <option key={v} value={v}>{AUTONOMY_META[v].label}</option>
              ))}
            </select>
          </div>
        </div>
        <div><label className="label">Objective</label><textarea className="input h-20" name="objective" placeholder="What is this agent responsible for?" /></div>
        <button className="btn">Add employee</button>
      </form>
    </div>
  );
}
