import { db } from './db';
import type { Prisma } from '@/generated/prisma/client';

export type JobType = 'send_message' | 'generate_drafts' | 'sync_wa_status' | 'run_agent_task' | 'process_media';

export async function enqueue(
  workspaceId: string,
  type: JobType,
  payload: Prisma.InputJsonValue,
  runAt = new Date(),
) {
  return db.job.create({ data: { workspaceId, type, payload, runAt } });
}

/** Claim one due job atomically-ish (single worker per deployment in v1). */
export async function claimJob() {
  const candidate = await db.job.findFirst({
    where: { status: 'pending', runAt: { lte: new Date() } },
    orderBy: { runAt: 'asc' },
  });
  if (!candidate) return null;
  const claimed = await db.job.updateMany({
    where: { id: candidate.id, status: 'pending' },
    data: { status: 'running', lockedAt: new Date(), attempts: { increment: 1 } },
  });
  if (claimed.count === 0) return null;
  return db.job.findUnique({ where: { id: candidate.id } });
}

export async function completeJob(id: string) {
  await db.job.update({ where: { id }, data: { status: 'done', lockedAt: null } });
}

export async function failJob(id: string, error: string) {
  const job = await db.job.findUnique({ where: { id } });
  if (!job) return;
  const done = job.attempts >= job.maxAttempts;
  await db.job.update({
    where: { id },
    data: {
      status: done ? 'failed' : 'pending',
      lastError: error.slice(0, 2000),
      lockedAt: null,
      runAt: done ? job.runAt : new Date(Date.now() + 60_000 * job.attempts),
    },
  });
}

export async function rescheduleJob(id: string, runAt: Date) {
  await db.job.update({
    where: { id },
    data: { status: 'pending', runAt, lockedAt: null, attempts: { decrement: 1 } },
  });
}

/** Requeue jobs a crashed worker left locked. */
export async function reclaimStale(olderThanMs = 5 * 60_000) {
  await db.job.updateMany({
    where: { status: 'running', lockedAt: { lt: new Date(Date.now() - olderThanMs) } },
    data: { status: 'pending', lockedAt: null },
  });
}
