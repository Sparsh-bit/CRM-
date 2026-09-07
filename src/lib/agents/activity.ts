/**
 * Append-only audit trail for what an agent did. Mirrors the shape of the
 * existing per-message Event model (type + meta + createdAt) at the agent
 * level instead of the message level. Never role-gated — logging happens as
 * a side effect of normal task/agent activity, not an administrative act.
 */
import { db } from '../db';
import type { Prisma } from '@/generated/prisma/client';

export type LogActivityInput = {
  agentId: string;
  taskId?: string | null;
  type: string;
  meta?: unknown;
};

export async function logActivity(workspaceId: string, data: LogActivityInput) {
  const type = data.type.trim();
  if (!type) throw new Error('Activity type is required.');

  const agent = await db.agent.findFirst({ where: { id: data.agentId, workspaceId } });
  if (!agent) throw new Error('Agent not found in this workspace.');

  if (data.taskId) {
    const task = await db.agentTask.findFirst({ where: { id: data.taskId, workspaceId, agentId: data.agentId } });
    if (!task) throw new Error('Task not found for this agent in this workspace.');
  }

  return db.agentActivityLog.create({
    data: {
      workspaceId,
      agentId: data.agentId,
      taskId: data.taskId ?? null,
      type,
      meta: (data.meta ?? null) as Prisma.InputJsonValue,
    },
  });
}

export async function listActivity(workspaceId: string, filter?: { agentId?: string; taskId?: string }) {
  return db.agentActivityLog.findMany({
    where: {
      workspaceId,
      ...(filter?.agentId ? { agentId: filter.agentId } : {}),
      ...(filter?.taskId ? { taskId: filter.taskId } : {}),
    },
    orderBy: { createdAt: 'desc' },
  });
}
