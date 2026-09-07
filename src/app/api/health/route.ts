/**
 * Lightweight production visibility (Section 17) — no external
 * observability stack, just the handful of real checks a deploy/monitor
 * actually needs: can we reach the database, is an AI provider configured,
 * and how is the job queue doing. Every field here is a real, live check —
 * never a hardcoded "ok".
 */
import { db } from '@/lib/db';

export const dynamic = 'force-dynamic';

async function checkDatabase(): Promise<{ ok: boolean; error?: string }> {
  try {
    await db.$queryRaw`SELECT 1`;
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

function checkAiProvider(): { configured: boolean; providers: string[] } {
  const providers = [
    process.env.GROQ_API_KEY && 'groq',
    process.env.ANTHROPIC_API_KEY && 'anthropic',
    process.env.OPENAI_API_KEY && 'openai',
  ].filter((p): p is string => !!p);
  return { configured: providers.length > 0, providers };
}

async function checkJobs() {
  const [pending, running, recentFailures] = await Promise.all([
    db.job.count({ where: { status: 'pending' } }),
    db.job.count({ where: { status: 'running' } }),
    db.job.findMany({
      where: { status: 'failed', createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } },
      orderBy: { createdAt: 'desc' }, take: 10, select: { id: true, type: true, lastError: true, createdAt: true },
    }),
  ]);
  // A worker not running looks identical to "no work right now" from inside
  // the web process — a genuinely stale queue (old pending jobs) is the
  // honest signal, not a fabricated "worker: up".
  const oldestPending = await db.job.findFirst({ where: { status: 'pending' }, orderBy: { runAt: 'asc' }, select: { runAt: true } });
  const queueStale = !!oldestPending && Date.now() - oldestPending.runAt.getTime() > 5 * 60_000;
  return { pending, running, recentFailures24h: recentFailures.length, recentFailures, queueStale };
}

export async function GET() {
  const [database, jobs] = await Promise.all([checkDatabase(), checkJobs()]);
  const ai = checkAiProvider();
  const storageProvider = (process.env.STORAGE_PROVIDER ?? 'local').toLowerCase();
  const searchProvider = process.env.SEARCH_PROVIDER || null;

  const healthy = database.ok; // the only truly fatal condition from inside this process — everything else is a warning, not a down signal
  const body = {
    status: healthy ? 'ok' : 'error',
    timestamp: new Date().toISOString(),
    database,
    ai,
    jobs,
    storage: { provider: storageProvider },
    search: { provider: searchProvider, configured: !!searchProvider },
  };
  return Response.json(body, { status: healthy ? 200 : 503 });
}
