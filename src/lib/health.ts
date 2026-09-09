/**
 * Shared health checks behind both /api/health (public, minimal) and
 * /api/health/detailed (authenticated, per-workspace). Split out of the
 * route handlers so neither has to duplicate the actual checks.
 */
import { db } from './db';

export async function checkDatabase(): Promise<{ ok: boolean; error?: string }> {
  try {
    await db.$queryRaw`SELECT 1`;
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export function checkAiProvider(): { configured: boolean; providers: string[] } {
  const providers = [
    process.env.GROQ_API_KEY && 'groq',
    process.env.ANTHROPIC_API_KEY && 'anthropic',
    process.env.OPENAI_API_KEY && 'openai',
  ].filter((p): p is string => !!p);
  return { configured: providers.length > 0, providers };
}

/**
 * Scoped to ONE workspace — this is what makes it safe to show an
 * authenticated admin of any workspace on the deployment. An earlier,
 * global (cross-workspace) version of this check was the whole reason this
 * had to move behind auth in the first place; scoping it here means the
 * detailed endpoint doesn't just trade "public leak" for "cross-tenant
 * leak to a different workspace's admin."
 */
export async function checkJobs(workspaceId: string) {
  const [pending, running, recentFailures] = await Promise.all([
    db.job.count({ where: { workspaceId, status: 'pending' } }),
    db.job.count({ where: { workspaceId, status: 'running' } }),
    db.job.findMany({
      where: { workspaceId, status: 'failed', createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } },
      orderBy: { createdAt: 'desc' }, take: 10, select: { id: true, type: true, lastError: true, createdAt: true },
    }),
  ]);
  // A worker not running looks identical to "no work right now" from inside
  // the web process — a genuinely stale queue (old pending jobs) is the
  // honest signal, not a fabricated "worker: up".
  const oldestPending = await db.job.findFirst({ where: { workspaceId, status: 'pending' }, orderBy: { runAt: 'asc' }, select: { runAt: true } });
  const queueStale = !!oldestPending && Date.now() - oldestPending.runAt.getTime() > 5 * 60_000;
  return { pending, running, recentFailures24h: recentFailures.length, recentFailures, queueStale };
}
