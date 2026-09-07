/**
 * Remembered approval decisions ("remember this policy") for one agent +
 * action type. Setting or changing one is administration — it changes what
 * ships without a human looking at it again — so it is admin-gated exactly
 * like agents.ts.
 */
import { db } from '../db';
import { atLeast, type Role } from '../session';
import { PolicyDecision } from '@/generated/prisma/enums';

export type PolicyActor = { workspaceId: string; role: Role };

function requireAdmin(actor: PolicyActor) {
  if (!atLeast(actor.role, 'admin')) {
    throw new Error(`Changing approval policy needs the admin role. You are ${actor.role} in this workspace.`);
  }
}

function parseDecision(value: string) {
  if (!(Object.values(PolicyDecision) as string[]).includes(value)) {
    throw new Error(`Invalid policy decision: "${value}". Must be one of ${Object.values(PolicyDecision).join(', ')}.`);
  }
  return value as PolicyDecision;
}

export async function upsertApprovalPolicy(
  actor: PolicyActor,
  data: { agentId: string; actionType: string; decision: string },
) {
  requireAdmin(actor);
  const actionType = data.actionType.trim();
  if (!actionType) throw new Error('Action type is required.');
  const decision = parseDecision(data.decision);

  const agent = await db.agent.findFirst({ where: { id: data.agentId, workspaceId: actor.workspaceId } });
  if (!agent) throw new Error('Agent not found in this workspace.');

  return db.approvalPolicy.upsert({
    where: { workspaceId_agentId_actionType: { workspaceId: actor.workspaceId, agentId: data.agentId, actionType } },
    create: { workspaceId: actor.workspaceId, agentId: data.agentId, actionType, decision },
    update: { decision },
  });
}

export async function deleteApprovalPolicy(actor: PolicyActor, policyId: string) {
  requireAdmin(actor);
  const existing = await db.approvalPolicy.findFirst({ where: { id: policyId, workspaceId: actor.workspaceId } });
  if (!existing) throw new Error('Policy not found in this workspace.');
  return db.approvalPolicy.delete({ where: { id: policyId } });
}

export async function getApprovalPolicy(workspaceId: string, agentId: string, actionType: string) {
  return db.approvalPolicy.findUnique({
    where: { workspaceId_agentId_actionType: { workspaceId, agentId, actionType } },
  });
}

export async function listApprovalPolicies(workspaceId: string, agentId?: string) {
  return db.approvalPolicy.findMany({
    where: { workspaceId, ...(agentId ? { agentId } : {}) },
    orderBy: { createdAt: 'desc' },
  });
}
