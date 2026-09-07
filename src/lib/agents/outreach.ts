/**
 * The one bridge between an agent's proposed outreach and the existing send
 * path. This module creates Approvals and, once one is Approved (by a human
 * or a standing ApprovalPolicy), a real Message row — nothing more. Sending
 * itself is entirely the existing worker's job (src/worker/sender.ts):
 * this code never imports a provider, never imports the scheduler, and
 * never calls sendEmail/sendText/sendSms. That boundary is the whole point.
 *
 * Idempotency: a Message is created for an Approval at most once
 * (Approval.messageId is unique and checked before creating one), and
 * proposeOutreach() itself refuses to open a second Pending/Approved
 * approval for the same agent+channel+lead — a retried or repeated
 * propose_send call is safe, not a duplicate outreach attempt.
 */
import { db } from '../db';
import { nanoid } from 'nanoid';
import { enqueue } from '../queue';
import { createApproval, decideApproval, getApproval } from './approvals';
import { logActivity } from './activity';
import { ApprovalState } from '@/generated/prisma/enums';
import type { Prisma } from '@/generated/prisma/client';

export type OutreachChannel = 'email' | 'whatsapp' | 'sms';

export type ProposeOutreachInput = {
  leadId: string;
  channel: OutreachChannel;
  body: string;
  reason: string;
  subject?: string;
  personalizationNote?: string;
  campaignId?: string;
  scheduledFor?: string;
};

type ProposedContent = {
  leadId: string; channel: OutreachChannel; to: string; subject: string | null; body: string;
  reason: string; personalizationNote: string | null; campaignId: string | null; scheduledFor: string | null;
  leadName: string | null;
};

function actionTypeFor(channel: OutreachChannel): string {
  return `send_${channel}`;
}

/** The exact set of actionTypes an Approval can carry that mean "this is an outreach send" — read by approvals.ts's decideApproval() to know when to materialize a Message. */
export const OUTREACH_ACTION_TYPES: readonly string[] = (['email', 'whatsapp', 'sms'] as const).map(actionTypeFor);

/** The exact per-channel "does this lead have what we need" check — mirrors campaign.ts's preflight. */
function recipientFor(channel: OutreachChannel, lead: { email: string | null; emailValid: boolean; phone: string | null }): string | null {
  if (channel === 'email') return lead.email && lead.emailValid ? lead.email : null;
  return lead.phone ?? null; // whatsapp and sms both key on phone, same as campaign.ts
}

async function isSuppressed(workspaceId: string, value: string): Promise<boolean> {
  const supp = await db.suppression.findFirst({ where: { workspaceId, value: value.toLowerCase() } });
  return !!supp;
}

/**
 * Real, tested meaning for autonomyLevel in this phase: a SuggestOnly agent
 * may draft (prepare_email/whatsapp/sms) but may not open a formal proposal
 * — it can only suggest, not put anything in front of a human or a policy.
 * Anything more permissive is unrelated to this check: even
 * DraftAndRequestApproval/ExecuteApprovedActions/Autonomous still go
 * through the exact same Approval below — the only thing that can ever skip
 * a human is an explicit, admin-set ApprovalPolicy (policies.ts), never
 * autonomyLevel by itself. That's what "never bypass approval because the
 * agent has high autonomy unless the workspace policy explicitly allows it"
 * means in code: autonomyLevel gates whether a proposal can be OPENED at
 * all, not whether it can skip review once opened.
 */
async function requireCanPropose(workspaceId: string, agentId: string) {
  const agent = await db.agent.findFirst({ where: { id: agentId, workspaceId } });
  if (!agent) throw new Error('Agent not found in this workspace.');
  if (agent.autonomyLevel === 'SuggestOnly') {
    throw new Error(`"${agent.name}" is set to Suggest Only and cannot propose outreach — raise its autonomy to Draft & Request Approval to allow this.`);
  }
}

export async function proposeOutreach(
  workspaceId: string,
  agentId: string,
  taskId: string,
  input: ProposeOutreachInput,
) {
  await requireCanPropose(workspaceId, agentId);

  const lead = await db.lead.findFirst({ where: { id: input.leadId, workspaceId } });
  if (!lead) throw new Error('Lead not found in this workspace.');
  if (lead.status === 'unsubscribed' || lead.status === 'bounced') {
    throw new Error(`Cannot propose outreach to this lead — status is "${lead.status}".`);
  }

  const to = recipientFor(input.channel, lead);
  if (!to) {
    throw new Error(
      input.channel === 'email' ? 'This lead has no valid email address.' : 'This lead has no phone number.',
    );
  }
  if (await isSuppressed(workspaceId, to)) {
    throw new Error(`${to} is on the suppression list — cannot propose outreach to it.`);
  }
  if (input.channel === 'email' && !input.subject?.trim()) {
    throw new Error('An email proposal needs a subject.');
  }
  if (!input.body.trim()) throw new Error('Message body is required.');

  const actionType = actionTypeFor(input.channel);

  // Idempotency: a repeat propose_send for the same agent+channel+lead that
  // hasn't been rejected yet returns the existing approval instead of
  // opening a second one — safe to call twice, not a duplicate outreach.
  const existing = await db.approval.findFirst({
    where: {
      workspaceId, agentId, actionType, status: { in: [ApprovalState.Pending, ApprovalState.Approved] },
      proposedContent: { path: ['leadId'], equals: input.leadId },
    },
  });
  if (existing) {
    return { approval: existing, summary: `Outreach to this lead on ${input.channel} was already proposed (${existing.status}).`, deduped: true };
  }

  const proposedContent: ProposedContent = {
    leadId: lead.id, channel: input.channel, to, subject: input.channel === 'email' ? (input.subject ?? null) : null,
    body: input.body, reason: input.reason, personalizationNote: input.personalizationNote ?? null,
    campaignId: input.campaignId ?? null, scheduledFor: input.scheduledFor ?? null,
    leadName: lead.fullName ?? lead.firstName ?? null,
  };

  await logActivity(workspaceId, { agentId, taskId, type: 'message_proposed', meta: { channel: input.channel, leadId: lead.id, to } });

  const approval = await createApproval(workspaceId, {
    taskId, agentId, actionType,
    proposedContent: proposedContent as unknown as Prisma.InputJsonValue,
    affectedRecordIds: [lead.id],
  });

  if (approval.status === ApprovalState.Pending) {
    await logActivity(workspaceId, { agentId, taskId, type: 'approval_requested', meta: { approvalId: approval.id, channel: input.channel } });
    return { approval, summary: `Proposed a ${input.channel} message to ${proposedContent.leadName ?? to} — awaiting approval.`, deduped: false };
  }

  // A standing ApprovalPolicy already decided this one (createApproval resolved it synchronously).
  await logActivity(workspaceId, {
    agentId, taskId, type: approval.status === ApprovalState.Approved ? 'approval_approved' : 'approval_rejected',
    meta: { approvalId: approval.id, channel: input.channel, decidedBy: 'policy' },
  });

  if (approval.status === ApprovalState.Approved) {
    const materialized = await materializeApprovedMessage(workspaceId, approval.id);
    return { approval: materialized.approval, summary: `Auto-approved by workspace policy and queued to send on ${input.channel}.`, deduped: false };
  }
  return { approval, summary: `Auto-rejected by workspace policy — nothing will be sent.`, deduped: false };
}

/**
 * Convenience wrapper for a caller that wants the resulting Message back,
 * not just the Approval — e.g. a test asserting a send was actually queued.
 * decideApproval() (approvals.ts) is the single authoritative decision path
 * now (it materializes outreach sends itself); this does no deciding of its
 * own, just reshapes that same call's result. Both the UI's decide() action
 * and this wrapper end up calling the exact same function.
 */
export async function decideOutreachApproval(
  workspaceId: string,
  approvalId: string,
  decision: 'Approved' | 'Rejected',
  decidedBy: string,
) {
  const updated = await decideApproval(workspaceId, approvalId, decision, decidedBy);
  const message = updated.messageId ? await db.message.findUnique({ where: { id: updated.messageId } }) : null;
  return { approval: updated, message };
}

/**
 * Turns an Approved outreach approval into a real Message row on the
 * existing send path. Safe to call more than once for the same approval —
 * Approval.messageId is checked first and the call is a no-op if already set.
 * Exported so approvals.ts's decideApproval() can invoke it directly — the
 * one legitimate reason for the circular import noted there.
 */
export async function materializeApprovedMessage(workspaceId: string, approvalId: string) {
  const approval = await getApproval(workspaceId, approvalId);
  if (!approval) throw new Error('Approval not found in this workspace.');
  if (approval.status !== ApprovalState.Approved) {
    throw new Error(`Cannot materialize a message for an approval that is ${approval.status}, not Approved.`);
  }
  if (approval.messageId) {
    const existingMessage = await db.message.findUnique({ where: { id: approval.messageId } });
    return { approval, message: existingMessage };
  }

  const content = approval.proposedContent as unknown as ProposedContent;

  // Re-check right before materializing — time may have passed between
  // proposal and a human's decision (the same "re-checked at send time"
  // caution src/worker/sender.ts already applies at the actual send).
  const lead = await db.lead.findFirst({ where: { id: content.leadId, workspaceId } });
  if (!lead || lead.status === 'unsubscribed' || lead.status === 'bounced' || (await isSuppressed(workspaceId, content.to))) {
    await logActivity(workspaceId, {
      agentId: approval.agentId, taskId: approval.taskId, type: 'message_failed',
      meta: { approvalId, reason: 'Recipient became unreachable (suppressed/unsubscribed) between proposal and approval.' },
    });
    return { approval, message: null };
  }

  const message = await db.message.create({
    data: {
      workspaceId, campaignId: content.campaignId, leadId: content.leadId, agentTaskId: approval.taskId,
      stepOrder: 0, channel: content.channel, toAddress: content.to,
      subject: content.channel === 'email' ? content.subject : null, body: content.body,
      trackingId: nanoid(22), status: 'queued',
      scheduledFor: content.scheduledFor ? new Date(content.scheduledFor) : new Date(),
    },
  });
  await logActivity(workspaceId, { agentId: approval.agentId, taskId: approval.taskId, type: 'message_created', meta: { messageId: message.id, channel: content.channel } });

  const updatedApproval = await db.approval.update({ where: { id: approvalId }, data: { messageId: message.id } });

  // Same enqueue the worker's own fallback sweep uses for a campaign-less
  // message (src/worker/index.ts) — sendDueMessages() sweeps by workspaceId
  // and ignores the job payload, so no campaignId is needed here.
  await enqueue(workspaceId, 'send_message', {});
  await logActivity(workspaceId, { agentId: approval.agentId, taskId: approval.taskId, type: 'message_queued', meta: { messageId: message.id } });

  return { approval: updatedApproval, message };
}
