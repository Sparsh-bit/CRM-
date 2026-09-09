import { redirect } from 'next/navigation';
import Link from 'next/link';
import { db } from '@/lib/db';
import { getSession, requireRole } from '@/lib/session';
import { getOnboardingStatus } from '@/lib/onboarding/status';
import { AGENT_TEMPLATES } from '@/lib/agents/templates';
import { createAgent, type AgentActor } from '@/lib/agents/agents';
import { createTask } from '@/lib/agents/tasks';
import { onboardingStepMeta } from '@/lib/ui/status';
import { AUTONOMY_META } from '@/app/workforce/_lib/status';
import { cx } from '@/lib/ui/cx';
import { PageHeader } from '@/components/PageHeader';
import { Card } from '@/components/Card';
import { Badge } from '@/components/Badge';
import { Button } from '@/components/Button';

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

// Presentation-only — helps someone pick a template. Never read by
// createBuiltins() below, which creates agents straight from AGENT_TEMPLATES.
const RECOMMENDED_USE: Record<string, string> = {
  'CEO / Strategy': 'A daily pulse on pipeline health without digging through reports.',
  Research: 'A full picture of one lead or company before a call.',
  Sales: 'Triage a large lead list into who to contact first.',
  Marketing: 'Compare campaign performance and see who is actually engaging.',
  Operations: 'A lightweight check on campaign state across the workspace.',
  Outreach: 'Draft outreach at scale — every send still waits for your approval.',
  'Social/Content Research': "Scout a lead's public presence before Research or Outreach picks it up.",
};

// Which steps get a real "go do this" link, and its label — steps whose
// action lives further down this same page (agents, sample task) or that
// have no destination of their own (ai, a deployment env var) get none.
const STEP_LINK: Partial<Record<string, string>> = {
  workspace: 'Open settings',
  profile: 'Edit profile',
  email: 'Connect Email',
  whatsapp: 'Connect WhatsApp',
  sms: 'Set up SMS',
  complete: 'Go to Workforce',
};

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
      <PageHeader
        title="Get started"
        description={
          complete
            ? 'Every required step is set up — this checklist stays here if you want to add more channels or employees.'
            : 'A live checklist — each status below is checked against your workspace right now, never a saved "done" flag.'
        }
      />

      <Card className="p-0 overflow-hidden divide-y divide-line">
        {steps.map((step) => (
          <div key={step.id} className="flex items-start justify-between gap-4 px-5 py-4">
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="card-heading text-sm">{step.label}</span>
                {step.optional && <span className="text-meta">Optional</span>}
              </div>
              <p className="text-secondary mt-0.5">{step.detail}</p>
              <p className="text-meta mt-1">{step.why}</p>
            </div>
            <div className="flex items-center gap-3 shrink-0">
              <Badge {...onboardingStepMeta[step.status]} />
              {STEP_LINK[step.id] && (
                <Link href={step.href} className="text-accent hover:underline text-sm">{STEP_LINK[step.id]}</Link>
              )}
            </div>
          </div>
        ))}
      </Card>

      <Card className="space-y-4">
        <div>
          <h2 className="card-heading">Create AI employees</h2>
          <p className="text-secondary mt-1">
            Built-in templates, least-privilege by default — none of them can send a message without your approval.
            Full customization (objective, instructions, tools, autonomy) is available anytime at{' '}
            <Link href="/workforce/agents" className="text-accent hover:underline">Workforce → Agents</Link>.
          </p>
        </div>
        <form action={createBuiltins} className="space-y-4">
          <div className="grid sm:grid-cols-2 gap-3">
            {AGENT_TEMPLATES.map((t) => {
              const already = existingRoles.has(t.role);
              return (
                <label
                  key={t.role}
                  className={cx(
                    'flex flex-col gap-2 rounded-lg border border-line p-4 min-w-0',
                    already ? 'opacity-60' : 'hover:border-accent/50 cursor-pointer transition-colors',
                  )}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <input type="checkbox" name="role" value={t.role} defaultChecked={!already} disabled={already} />
                      <span className="font-medium text-sm text-slate-100">{t.name}</span>
                    </div>
                    {already && <span className="text-meta text-good shrink-0">Already created</span>}
                  </div>
                  <p className="text-secondary">{t.objective}</p>
                  <p className="text-meta">{RECOMMENDED_USE[t.role]}</p>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge {...AUTONOMY_META[t.autonomyLevel]} />
                    {t.allowedTools.map((tool) => <Badge key={tool} label={tool} tone="muted" />)}
                  </div>
                </label>
              );
            })}
          </div>
          <Button type="submit">Create selected</Button>
        </form>
      </Card>

      <Card className="space-y-3">
        <h2 className="card-heading">Optional: run a real sample task</h2>
        {researchAgentExists && hasLeads ? (
          <>
            <p className="text-secondary">Runs a real, read-only research task on your most recently imported lead through the actual Workforce pipeline — nothing here is a simulated demo.</p>
            <form action={runSampleTask}><Button type="submit" variant="secondary">Run sample task</Button></form>
          </>
        ) : (
          <p className="text-secondary">
            {!researchAgentExists ? 'Create the Research employee above first. ' : ''}
            {!hasLeads ? 'Import at least one lead from Lists first. ' : ''}
            A sample task needs both — never faked with placeholder data.
          </p>
        )}
      </Card>
    </div>
  );
}
