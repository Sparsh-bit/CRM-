/**
 * AI employee CRUD. Every write here is administration — creating an agent,
 * changing what it may do, changing how much it may do without a human,
 * removing it — so every write requires the admin role, exactly like the
 * account-level pages in src/app/{mailboxes,whatsapp,settings}.
 *
 * These functions don't call getSession()/requireRole() themselves: those
 * depend on next/headers cookies() and only work inside a request. Instead
 * the caller (a server action, a route, a test) resolves the actor's role —
 * from the database, via currentRole(), never a cookie — and passes it in.
 * The decision itself (`atLeast`) still happens in here, not in the caller,
 * so a future caller cannot ship a write path that forgets the check.
 */
import { db } from '../db';
import { atLeast, type Role } from '../session';
import { parseAutonomyLevel } from './validation';
import { AutonomyLevel } from '@/generated/prisma/enums';
import type { Prisma } from '@/generated/prisma/client';

export type AgentActor = { workspaceId: string; role: Role };

function requireAdmin(actor: AgentActor) {
  if (!atLeast(actor.role, 'admin')) {
    throw new Error(`Managing AI employees needs the admin role. You are ${actor.role} in this workspace.`);
  }
}

export type CreateAgentInput = {
  name: string;
  role: string;
  department?: string | null;
  objective?: string | null;
  instructions?: string | null;
  allowedTools?: string[];
  autonomyLevel?: string; // validated below — never trust a caller's literal
  config?: Record<string, unknown>;
};

export async function createAgent(actor: AgentActor, input: CreateAgentInput) {
  requireAdmin(actor);
  const name = input.name.trim();
  const role = input.role.trim();
  if (!name) throw new Error('Name is required.');
  if (!role) throw new Error('Role is required.');
  const autonomyLevel = input.autonomyLevel ? parseAutonomyLevel(input.autonomyLevel) : AutonomyLevel.SuggestOnly;

  return db.agent.create({
    data: {
      workspaceId: actor.workspaceId,
      name,
      role,
      department: input.department?.trim() || null,
      objective: input.objective ?? null,
      instructions: input.instructions ?? null,
      allowedTools: (input.allowedTools ?? []) as Prisma.InputJsonValue,
      autonomyLevel,
      config: (input.config ?? {}) as Prisma.InputJsonValue,
    },
  });
}

export type UpdateAgentInput = Partial<CreateAgentInput> & { status?: string };

const AGENT_STATUSES = ['active', 'paused', 'archived'];

export async function updateAgent(actor: AgentActor, agentId: string, patch: UpdateAgentInput) {
  requireAdmin(actor);
  const existing = await db.agent.findFirst({ where: { id: agentId, workspaceId: actor.workspaceId } });
  if (!existing) throw new Error('Agent not found in this workspace.');

  if (patch.status && !AGENT_STATUSES.includes(patch.status)) {
    throw new Error(`Invalid agent status: "${patch.status}". Must be one of ${AGENT_STATUSES.join(', ')}.`);
  }

  return db.agent.update({
    where: { id: agentId },
    data: {
      ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
      ...(patch.role !== undefined ? { role: patch.role.trim() } : {}),
      ...(patch.department !== undefined ? { department: patch.department?.trim() || null } : {}),
      ...(patch.objective !== undefined ? { objective: patch.objective } : {}),
      ...(patch.instructions !== undefined ? { instructions: patch.instructions } : {}),
      ...(patch.allowedTools !== undefined ? { allowedTools: patch.allowedTools as Prisma.InputJsonValue } : {}),
      ...(patch.autonomyLevel !== undefined ? { autonomyLevel: parseAutonomyLevel(patch.autonomyLevel) } : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.config !== undefined ? { config: patch.config as Prisma.InputJsonValue } : {}),
    },
  });
}

/**
 * Refuses to delete an agent with task history — that history is the audit
 * trail this whole system exists to keep. Archive it (status: "archived")
 * instead; only an agent nobody ever assigned work to can actually be removed.
 */
export async function deleteAgent(actor: AgentActor, agentId: string) {
  requireAdmin(actor);
  const existing = await db.agent.findFirst({ where: { id: agentId, workspaceId: actor.workspaceId } });
  if (!existing) throw new Error('Agent not found in this workspace.');

  const taskCount = await db.agentTask.count({ where: { agentId } });
  if (taskCount > 0) {
    throw new Error(
      `Cannot delete "${existing.name}": it has ${taskCount} task${taskCount === 1 ? '' : 's'} on record. ` +
      `Set its status to "archived" instead to preserve the audit trail.`,
    );
  }

  return db.agent.delete({ where: { id: agentId } });
}

/** Any workspace member may look — only administration is role-gated. */
export async function listAgents(workspaceId: string) {
  return db.agent.findMany({ where: { workspaceId }, orderBy: { createdAt: 'asc' } });
}

export async function getAgent(workspaceId: string, agentId: string) {
  return db.agent.findFirst({ where: { id: agentId, workspaceId } });
}
