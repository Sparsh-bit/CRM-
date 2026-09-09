/**
 * Human-in-the-loop gate for one proposed action from one task. Requesting an
 * approval and deciding it are both normal use, not administration — the
 * thing that IS administration (setting the remembered policy that can
 * bypass this) lives in policies.ts and is gated there.
 */
import { db } from '../db';
import { ApprovalState } from '@/generated/prisma/enums';
import type { Prisma } from '@/generated/prisma/client';
import { atLeast, type Role } from '../session';
import { getApprovalPolicy } from './policies';
import { logActivity } from './activity';
// outreach.ts imports createApproval/decideApproval/getApproval from here too —
// a real circular import, but a safe one: both sides only touch each other's
// exports from inside function bodies, never at module top level, so there is
// no load-order dependency. This is the ONE place a decision is made (the UI's
// decide() action calls decideApproval() directly, same as any other caller);
// outreach.ts registering its own materialization here would need approvals.ts
// to import it back anyway, so there is no version of "backend-authoritative,
// single entry point" that avoids this edge.
import { materializeApprovedMessage, OUTREACH_ACTION_TYPES } from './outreach';

export type ApprovalActor = { workspaceId: string; role: Role };

/**
 * Deciding a pending approval is exactly "changes who can send" (session.ts's
 * own definition of what requireRole gates) — approving one materializes a
 * real outbound Message. Gated here, not just in the calling page, so no
 * future caller (a route, a script, another UI) can accidentally approve a
 * real send on behalf of a workspace member who shouldn't be able to.
 */
function requireAdmin(actor: ApprovalActor) {
  if (!atLeast(actor.role, 'admin')) {
    throw new Error(`Deciding an approval needs the admin role. You are ${actor.role} in this workspace.`);
  }
}

export type CreateApprovalInput = {
  taskId: string;
  agentId: string;
  actionType: string;
  proposedContent: unknown;
  affectedRecordIds?: string[];
};

/**
 * A remembered ApprovalPolicy for this agent + actionType resolves the
 * approval immediately (Approved/Rejected, decidedBy left null — nobody
 * decided this instance, a standing policy did) instead of leaving it Pending
 * for a human.
 */
export async function createApproval(workspaceId: string, data: CreateApprovalInput) {
  const actionType = data.actionType.trim();
  if (!actionType) throw new Error('Action type is required.');

  const task = await db.agentTask.findFirst({ where: { id: data.taskId, workspaceId, agentId: data.agentId } });
  if (!task) throw new Error('Task not found for this agent in this workspace.');

  const policy = await getApprovalPolicy(workspaceId, data.agentId, actionType);
  const status = policy?.decision === 'AutoApprove'
    ? ApprovalState.Approved
    : policy?.decision === 'AutoReject'
      ? ApprovalState.Rejected
      : ApprovalState.Pending;

  const approval = await db.approval.create({
    data: {
      workspaceId,
      taskId: data.taskId,
      agentId: data.agentId,
      actionType,
      proposedContent: data.proposedContent as Prisma.InputJsonValue,
      affectedRecordIds: (data.affectedRecordIds ?? []) as Prisma.InputJsonValue,
      status,
      decidedAt: policy ? new Date() : null,
    },
  });

  await db.agentTask.update({ where: { id: data.taskId }, data: { approvalState: status } });
  return approval;
}

export async function decideApproval(
  actor: ApprovalActor,
  approvalId: string,
  decision: 'Approved' | 'Rejected',
  decidedBy: string,
) {
  requireAdmin(actor);
  const { workspaceId } = actor;

  const approval = await db.approval.findFirst({ where: { id: approvalId, workspaceId } });
  if (!approval) throw new Error('Approval not found in this workspace.');

  // Atomic compare-and-swap on status — the same conditional-updateMany
  // pattern claimJob() uses for Job claiming (queue.ts). A plain
  // read-then-write here let two concurrent decisions both pass the Pending
  // check and both go on to materialize a Message (a double-send); this
  // update only ever succeeds for whichever request gets there first — a
  // second, concurrent or repeated call sees 0 rows affected and throws,
  // exactly as it already did for a sequential repeat decision.
  const claimed = await db.approval.updateMany({
    where: { id: approvalId, workspaceId, status: ApprovalState.Pending },
    data: { status: decision, decidedBy, decidedAt: new Date() },
  });
  if (claimed.count === 0) {
    const current = await db.approval.findFirst({ where: { id: approvalId, workspaceId } });
    throw new Error(`This approval was already decided (${current?.status ?? approval.status}).`);
  }
  const updated = await db.approval.findFirstOrThrow({ where: { id: approvalId, workspaceId } });
  await db.agentTask.update({ where: { id: approval.taskId }, data: { approvalState: decision } });
  await logActivity(workspaceId, {
    agentId: approval.agentId, taskId: approval.taskId,
    type: decision === 'Approved' ? 'approval_approved' : 'approval_rejected',
    meta: { approvalId, decidedBy },
  });

  // The ONE domain-specific consequence a decision can have: an approved
  // outreach send materializes into a real, queued Message here — the single
  // authoritative place every caller's decision (the UI's decide() action
  // included) goes through, so nothing can flip an outreach approval to
  // Approved without also queuing the send. Non-outreach action types (or a
  // Rejected decision) pass through unchanged, exactly as before.
  if (decision === ApprovalState.Approved && OUTREACH_ACTION_TYPES.includes(approval.actionType)) {
    await materializeApprovedMessage(workspaceId, approvalId);
    return db.approval.findFirstOrThrow({ where: { id: approvalId, workspaceId } }); // reflect the messageId materialize just set
  }
  return updated;
}

export async function getApproval(workspaceId: string, approvalId: string) {
  return db.approval.findFirst({ where: { id: approvalId, workspaceId } });
}

export async function listApprovals(
  workspaceId: string,
  filter?: { taskId?: string; agentId?: string; status?: ApprovalState },
) {
  return db.approval.findMany({
    where: {
      workspaceId,
      ...(filter?.taskId ? { taskId: filter.taskId } : {}),
      ...(filter?.agentId ? { agentId: filter.agentId } : {}),
      ...(filter?.status ? { status: filter.status } : {}),
    },
    orderBy: { createdAt: 'desc' },
  });
}
