/**
 * Human-in-the-loop gate for one proposed action from one task. Requesting an
 * approval and deciding it are both normal use, not administration — the
 * thing that IS administration (setting the remembered policy that can
 * bypass this) lives in policies.ts and is gated there.
 */
import { db } from '../db';
import { ApprovalState } from '@/generated/prisma/enums';
import type { Prisma } from '@/generated/prisma/client';
import { getApprovalPolicy } from './policies';

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
  workspaceId: string,
  approvalId: string,
  decision: 'Approved' | 'Rejected',
  decidedBy: string,
) {
  const approval = await db.approval.findFirst({ where: { id: approvalId, workspaceId } });
  if (!approval) throw new Error('Approval not found in this workspace.');
  if (approval.status !== ApprovalState.Pending) {
    throw new Error(`This approval was already decided (${approval.status}).`);
  }

  const updated = await db.approval.update({
    where: { id: approvalId },
    data: { status: decision, decidedBy, decidedAt: new Date() },
  });
  await db.agentTask.update({ where: { id: approval.taskId }, data: { approvalState: decision } });
  return updated;
}

export async function getApproval(workspaceId: string, approvalId: string) {
  return db.approval.findFirst({ where: { id: approvalId, workspaceId } });
}

export async function listApprovals(workspaceId: string, filter?: { taskId?: string; status?: ApprovalState }) {
  return db.approval.findMany({
    where: {
      workspaceId,
      ...(filter?.taskId ? { taskId: filter.taskId } : {}),
      ...(filter?.status ? { status: filter.status } : {}),
    },
    orderBy: { createdAt: 'desc' },
  });
}
