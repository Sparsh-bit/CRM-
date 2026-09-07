/**
 * The one place quota is checked and usage is recorded (Section 7): every
 * feature that spends a metered resource calls checkQuota() before doing
 * the real work and recordUsage() only after it actually happened —
 * exactly the "operation -> UsageService -> check quota -> execute ->
 * record usage" shape asked for, and the only place that shape is
 * implemented (no per-feature quota logic anywhere else).
 *
 * "Do not consume usage if the operation never happened" is enforced by
 * convention at every call site (see the integration points listed in
 * docs/usage.md), not by this module alone — this module only refuses to
 * let an operation START over quota; it has no way to know from here
 * whether a caller's own operation actually succeeded afterward.
 */
import { db } from '../db';
import { planLimits, PERIOD_DAYS, type UsageKind, type GaugeKind } from './plans';
import type { Prisma } from '@/generated/prisma/client';

export class QuotaExceededError extends Error {
  constructor(public kind: UsageKind | GaugeKind, public limit: number, public current: number) {
    super(`Usage limit reached for "${kind}": ${current}/${limit} in the current period. Upgrade the plan or wait for the period to roll over.`);
  }
}

async function workspacePlan(workspaceId: string) {
  const ws = await db.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { plan: true, quotaOverrides: true } });
  return planLimits(ws.plan, ws.quotaOverrides);
}

function periodStart(): Date {
  return new Date(Date.now() - PERIOD_DAYS * 24 * 60 * 60 * 1000);
}

/** Current-period sum for a counted kind (a rolling window, not calendar-month — see plans.ts). */
export async function currentUsage(workspaceId: string, kind: UsageKind): Promise<number> {
  const agg = await db.usageEvent.aggregate({
    where: { workspaceId, kind, createdAt: { gte: periodStart() } },
    _sum: { quantity: true },
  });
  return agg._sum.quantity ?? 0;
}

/**
 * Throws QuotaExceededError if recording `amount` more of `kind` would put
 * this workspace over its plan's limit. A missing/undefined limit means
 * unlimited. Never writes anything — a pure check, safe to call before an
 * operation has committed to anything.
 */
export async function checkQuota(workspaceId: string, kind: UsageKind, amount = 1): Promise<void> {
  const limits = await workspacePlan(workspaceId);
  const limit = limits[kind];
  if (limit === undefined) return;
  const used = await currentUsage(workspaceId, kind);
  if (used + amount > limit) throw new QuotaExceededError(kind, limit, used);
}

/** Same shape for a live gauge (agent count, storage bytes) instead of a period sum — pass the ALREADY-COMPUTED current value, since each gauge is counted its own way (db.agent.count, a sizeBytes sum, ...). */
export function checkGaugeQuota(limits: Record<string, number | undefined>, kind: GaugeKind, current: number, addingAmount = 1): void {
  const limit = limits[kind];
  if (limit === undefined) return;
  if (current + addingAmount > limit) throw new QuotaExceededError(kind, limit, current);
}

export async function workspaceLimits(workspaceId: string) {
  return workspacePlan(workspaceId);
}

/**
 * Records ONE real, already-happened event. `quantity` defaults to 1 (one
 * task, one message, one analysis); pass a real measured quantity for
 * ai_tokens (never estimated/fabricated — omit the call entirely if the
 * provider didn't report a token count, per Section 5).
 */
export async function recordUsage(workspaceId: string, kind: UsageKind, quantity = 1, meta?: unknown): Promise<void> {
  try {
    await db.usageEvent.create({ data: { workspaceId, kind, quantity, meta: (meta ?? null) as Prisma.InputJsonValue } });
  } catch (e) {
    // Usage accounting must never take down the real operation it's recording — same guard ai/provider.ts's own recordUsage already used.
    console.error('[usage]', e instanceof Error ? e.message : e);
  }
}

export type UsageSummary = {
  plan: string;
  periodDays: number;
  counters: Partial<Record<UsageKind, { used: number; limit: number | null }>>;
  gauges: Partial<Record<GaugeKind, { used: number; limit: number | null }>>;
};

/** Real aggregation for a workspace's usage dashboard/API — every number here is a real query, never estimated. */
export async function getUsageSummary(workspaceId: string): Promise<UsageSummary> {
  const ws = await db.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { plan: true, quotaOverrides: true } });
  const limits = planLimits(ws.plan, ws.quotaOverrides);

  const kinds: UsageKind[] = ['ai_request', 'ai_tokens', 'agent_task', 'research_task', 'media_analysis', 'message', 'lead_processed'];
  const counters: UsageSummary['counters'] = {};
  for (const kind of kinds) {
    counters[kind] = { used: await currentUsage(workspaceId, kind), limit: limits[kind] ?? null };
  }

  const agentCount = await db.agent.count({ where: { workspaceId } });
  const storageAgg = await db.mediaAsset.aggregate({ where: { workspaceId }, _sum: { sizeBytes: true } });
  const gauges: UsageSummary['gauges'] = {
    agents: { used: agentCount, limit: limits.agents ?? null },
    storage_bytes: { used: storageAgg._sum.sizeBytes ?? 0, limit: limits.storage_bytes ?? null },
  };

  return { plan: ws.plan, periodDays: PERIOD_DAYS, counters, gauges };
}
