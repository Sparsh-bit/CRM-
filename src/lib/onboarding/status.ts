/**
 * Real, workspace-scoped onboarding status (Section 2) — every step below
 * is a live database/env query, never a stored "I finished this wizard"
 * flag that could drift from reality. A step reports exactly one of the
 * five states the brief asked for, computed from what's actually connected
 * right now.
 */
import { db } from '../db';
import { AGENT_TEMPLATES } from '../agents/templates';

export type StepStatus = 'not_configured' | 'configured' | 'connected' | 'error' | 'needs_attention';

export type OnboardingStep = {
  id: string;
  label: string;
  status: StepStatus;
  detail: string;
  href: string;
  optional?: boolean;
};

export type OnboardingStatus = {
  steps: OnboardingStep[];
  /** True once every non-optional step is at least "configured" (an error still blocks — Section 2: "do not mark a setup step complete unless it is actually complete"). */
  complete: boolean;
};

function aiConfigured(): boolean {
  return !!(process.env.GROQ_API_KEY || process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY);
}

export async function getOnboardingStatus(workspaceId: string): Promise<OnboardingStatus> {
  const ws = await db.workspace.findUniqueOrThrow({ where: { id: workspaceId } });

  const [mailboxes, waInstances, smsGateways, agentCount, taskCount, leadCount] = await Promise.all([
    db.mailbox.findMany({ where: { workspaceId } }),
    db.waInstance.findMany({ where: { workspaceId } }),
    db.smsGateway.findMany({ where: { workspaceId } }),
    db.agent.count({ where: { workspaceId } }),
    db.agentTask.count({ where: { workspaceId } }),
    db.lead.count({ where: { workspaceId } }),
  ]);

  const profileConfigured = !!(ws.senderName?.trim() && ws.senderCompany?.trim());

  const emailStatus: StepStatus =
    mailboxes.some((m) => m.status === 'active') ? 'connected'
    : mailboxes.some((m) => m.status === 'error') ? 'error'
    : mailboxes.length ? 'needs_attention'
    : 'not_configured';

  const waStatus: StepStatus =
    waInstances.some((w) => w.status === 'connected') ? 'connected'
    : waInstances.some((w) => w.status === 'error') ? 'error'
    : waInstances.length ? 'needs_attention' // created but still qr/disconnected — scan the QR or reconnect
    : 'not_configured';

  const smsStatus: StepStatus =
    smsGateways.some((g) => g.status === 'connected') ? 'connected'
    : smsGateways.some((g) => g.status === 'error') ? 'error'
    : smsGateways.length ? 'needs_attention'
    : 'not_configured';

  const steps: OnboardingStep[] = [
    { id: 'workspace', label: 'Workspace setup', status: 'connected', detail: `"${ws.name}" is created and ready.`, href: '/settings' },
    { id: 'profile', label: 'Profile / company information', status: profileConfigured ? 'configured' : 'needs_attention', detail: profileConfigured ? `Sending as ${ws.senderName} at ${ws.senderCompany}.` : 'Set a sender name and company — the AI writer and every outgoing message use this.', href: '/settings' },
    { id: 'email', label: 'Connect Email', status: emailStatus, detail: mailboxes.length ? `${mailboxes.length} mailbox(es), ${mailboxes.filter((m) => m.status === 'active').length} active.` : 'No mailbox connected yet.', href: '/mailboxes' },
    { id: 'whatsapp', label: 'Connect WhatsApp', status: waStatus, detail: waInstances.length ? `${waInstances.length} number(s), ${waInstances.filter((w) => w.status === 'connected').length} connected.` : 'No WhatsApp number connected yet.', href: '/whatsapp' },
    { id: 'sms', label: 'Connect SMS', status: smsStatus, detail: smsGateways.length ? `${smsGateways.length} gateway(s), ${smsGateways.filter((g) => g.status === 'connected').length} connected.` : 'No SMS gateway connected yet.', href: '/sms' },
    { id: 'ai', label: 'AI configuration', status: aiConfigured() ? 'configured' : 'not_configured', detail: aiConfigured() ? 'An AI provider key is configured on this deployment.' : 'No AI provider key is set (GROQ_API_KEY/ANTHROPIC_API_KEY/OPENAI_API_KEY) — AI employees cannot draft, research, or analyze yet.', href: '/onboarding' },
    { id: 'agents', label: 'Create AI employees', status: agentCount > 0 ? 'connected' : 'not_configured', detail: agentCount > 0 ? `${agentCount} AI employee(s) created.` : `${AGENT_TEMPLATES.length} built-in templates are ready to use.`, href: '/onboarding' },
    { id: 'sample_task', label: 'Optional sample task', status: taskCount > 0 ? 'connected' : 'not_configured', detail: taskCount > 0 ? `${taskCount} task(s) have run.` : leadCount > 0 ? 'Ready — you have leads to try a real task on.' : 'Import a lead first to try a real sample task.', href: '/onboarding', optional: true },
    { id: 'complete', label: 'Completion', status: 'connected', detail: 'Always available — Workforce is one click away regardless of setup progress.', href: '/workforce' },
  ];

  const required = steps.filter((s) => !s.optional && s.id !== 'complete');
  const complete = required.every((s) => s.status === 'connected' || s.status === 'configured');

  return { steps, complete };
}
