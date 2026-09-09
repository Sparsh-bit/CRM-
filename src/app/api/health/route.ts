/**
 * Public health check — no session, so nothing here is workspace- or
 * deployment-internal: a real DB reachability check, boolean status only.
 * A security audit found the previous version of this route returned raw
 * DB exception text, per-workspace job-failure error strings, queue
 * depth, and the configured AI provider list to ANY unauthenticated
 * caller. That detail now lives at /api/health/detailed, behind
 * requireRole('admin') and scoped to the caller's own workspace — see
 * src/app/api/health/detailed/route.ts and src/lib/health.ts.
 */
import { checkDatabase } from '@/lib/health';

export const dynamic = 'force-dynamic';

export async function GET() {
  const database = await checkDatabase();
  const healthy = database.ok;
  return Response.json(
    { status: healthy ? 'ok' : 'error', timestamp: new Date().toISOString() },
    { status: healthy ? 200 : 503 },
  );
}
