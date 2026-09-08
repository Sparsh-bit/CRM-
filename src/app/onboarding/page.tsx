import { redirect } from 'next/navigation';
import Link from 'next/link';
import { db } from '@/lib/db';
import { getSession, requireRole } from '@/lib/session';
import { getOnboardingStatus } from '@/lib/onboarding/status';
import { AGENT_TEMPLATES } from '@/lib/agents/templates';
import { createAgent, type AgentActor } from '@/lib/agents/agents';
import { createTask } from '@/lib/agents/tasks';
import { onboardingStepMeta, pillClass } from '@/lib/ui/status';

export const dynamic = 'force-dynamic';

/**
 * First-time workspace onboarding (Section 2). Every step's status comes
 * from src/lib/onboarding/status.ts's real queries — nothing here is a
 * stored "wizard finished" flag. Section 3's built-in-employee quick-start
 * uses the EXISTING template/agent architecture (AGENT_TEMPLATES,
 * createAgent()) — no second agent system. Full customization (objective,
 * instructions, tool review, autonomy) is one click away at
 * /workforce/agents, which already has its own create/edit flow — this page
 * only offers the fast "use the built-in defaults" path Section 3 asks for.
 */
async function createBuiltins(formData: FormData) {
  'use server';
  const s = await getSession();
  if (!s) redirect('/login');
  const { role } = await requireRole('admin');
  const actor: AgentActor = { workspaceId: s.workspaceId, role };
  const existing = new Set((await db.agent.findMany({ where: { workspaceId: s.workspaceId }, select: { role: true } })).map((a) => a.role));
  const selected = formData.getAll('role').map(String);
  for (const t of AGENT_TEMPLATES) {
    if (!selected.includes(t.role) || existing.has(t.role)) continue;
    // Exactly the template's own defaults — autonomy is never upgraded here (Section 3: "default autonomy MUST remain safe").
    await createAgent(actor, { name: t.name, role: t.role, department: t.department, objective: t.objective, allowedTools: t.allowedTools, autonomyLevel: t.autonomyLevel });
  }
  redirect('/onboarding');
}

async function runSampleTask() {
  'use server';
  const s = await getSession();
  if (!s) redirect('/login');
  const researchAgent = await db.agent.findFirst({ where: { workspaceId: s.workspaceId, role: 'Research' } });
  if (!researchAgent) redirect('/onboarding'); // nothing to run it with — the UI below explains this
  const lead = await db.lead.findFirst({ where: { workspaceId: s.workspaceId }, orderBy: { createdAt: 'desc' } });
  if (!lead) redirect('/onboarding'); // nothing real to research yet — never fabricate one
  await createTask(s.workspaceId, {
    agentId: researchAgent.id, title: 'Onboarding sample task: summarize a real lead',
    input: { toolCalls: [{ tool: 'summarize_lead', args: { leadId: lead.id } }] },
  });
  redirect('/workforce/tasks');
}

export default async function OnboardingPage() {
  const s = await getSession();
  if (!s) redirect('/login');
  const { steps, complete } = await getOnboardingStatus(s.workspaceId);
  const existingRoles = new Set((await db.agent.findMany({ where: { workspaceId: s.workspaceId }, select: { role: true } })).map((a) => a.role));
  const researchAgentExists = existingRoles.has('Research');
  const hasLeads = (await db.lead.count({ where: { workspaceId: s.workspaceId } })) > 0;

  return (
    <div className="max-w-3xl space-y-8">
      <div>
        <h1 className="text-2xl font-semibold">Get started</h1>
        <p className="text-sm text-muted mt-1">
          {complete ? 'Every required step is set up — this checklist stays here if you want to add more channels or employees.' : 'A real, live checklist — each status below is checked against the database right now, not a saved "done" flag.'}
        </p>
      </div>

      <div className="card p-0 overflow-hidden">
        {steps.map((step) => (
          <div key={step.id} className="flex items-center justify-between gap-4 px-5 py-4 border-b border-line last:border-0">
            <div>
              <div className="text-sm font-medium">{step.label}{step.optional && <span className="text-xs text-muted ml-2">(optional)</span>}</div>
              <div className="text-xs text-muted mt-0.5">{step.detail}</div>
            </div>
            <div className="flex items-center gap-3 shrink-0">
              <span className={pillClass(onboardingStepMeta[step.status].tone)}>{onboardingStepMeta[step.status].label}</span>
              {step.id !== 'complete' && step.id !== 'agents' && step.id !== 'sample_task' && (
                <Link href={step.href} className="text-xs text-accent hover:underline">Open</Link>
              )}
            </div>
          </div>
        ))}
      </div>

      <div className="card space-y-4">
        <div>
          <div className="font-medium">Create AI employees</div>
          <p className="text-xs text-muted mt-1">
            Built-in templates, least-privilege by default (never autonomous messaging — every send still requires approval).
            Full customization (objective, instructions, tools, autonomy) is available anytime at{' '}
            <Link href="/workforce/agents" className="text-accent hover:underline">Workforce → Agents</Link>.
          </p>
        </div>
        <form action={createBuiltins} className="space-y-3">
          {AGENT_TEMPLATES.map((t) => (
            <label key={t.role} className="flex items-start gap-3 text-sm">
              <input type="checkbox" name="role" value={t.role} defaultChecked={!existingRoles.has(t.role)} disabled={existingRoles.has(t.role)} className="mt-1" />
              <span>
                <span className="font-medium">{t.name}</span>{existingRoles.has(t.role) && <span className="text-xs text-good ml-2">already created</span>}
                <span className="block text-xs text-muted">{t.objective}</span>
              </span>
            </label>
          ))}
          <button className="btn">Create selected</button>
        </form>
      </div>

      <div className="card space-y-3">
        <div className="font-medium">Optional: run a real sample task</div>
        {researchAgentExists && hasLeads ? (
          <>
            <p className="text-xs text-muted">Runs a real, read-only summarize_lead task on your most recently imported lead through the actual AgentRuntime/Job/worker pipeline.</p>
            <form action={runSampleTask}><button className="btn-sec">Run sample task</button></form>
          </>
        ) : (
          <p className="text-xs text-muted">
            {!researchAgentExists ? 'Create the Research employee above first. ' : ''}
            {!hasLeads ? 'Import at least one lead from Lists first. ' : ''}
            A sample task needs both — never faked with placeholder data.
          </p>
        )}
      </div>
    </div>
  );
}
