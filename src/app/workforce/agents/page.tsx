import { redirect } from 'next/navigation';
import Link from 'next/link';
import { db } from '@/lib/db';
import { getSession, requireSession, currentRole } from '@/lib/session';
import { createAgent } from '@/lib/agents/agents';
import { AutonomyLevel } from '@/generated/prisma/enums';
import { agentStatusMeta, AUTONOMY_META } from '../_lib/status';
import { Card } from '@/components/Card';
import { Badge } from '@/components/Badge';
import { Button } from '@/components/Button';

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
      {agents.length ? (
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {agents.map((a) => (
            <Link key={a.id} href={`/workforce/agents/${a.id}`} className="group min-w-0">
              <Card className="h-full space-y-3 hover:border-accent/40 transition-colors">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="w-9 h-9 rounded-lg bg-line flex items-center justify-center text-xs font-display font-semibold shrink-0">
                      {a.name.slice(0, 2).toUpperCase()}
                    </div>
                    <div className="min-w-0">
                      <div className="text-sm font-medium truncate group-hover:text-accent transition-colors">{a.name}</div>
                      <div className="text-secondary truncate">{a.role}{a.department ? ` · ${a.department}` : ''}</div>
                    </div>
                  </div>
                  <Badge {...agentStatusMeta(a.status)} className="shrink-0" />
                </div>
                <div className="flex items-center justify-between border-t border-line pt-3">
                  <span className="text-secondary">{a._count.tasks} task{a._count.tasks === 1 ? '' : 's'}</span>
                  <Badge {...AUTONOMY_META[a.autonomyLevel]} />
                </div>
              </Card>
            </Link>
          ))}
        </div>
      ) : (
        <Card className="text-center py-12 text-secondary">No AI employees yet — add your first one below.</Card>
      )}

      <form action={create} className="card space-y-4 max-w-2xl">
        <div className="card-heading">New AI employee</div>
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
        <Button type="submit">Add employee</Button>
      </form>
    </div>
  );
}
