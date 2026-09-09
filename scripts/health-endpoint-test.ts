/**
 * Regression test for the health-endpoint leak a security audit found:
 * /api/health was public and returned raw DB exception text, per-workspace
 * job-failure error strings (cross-tenant — no workspace scoping at all),
 * queue depth, and the configured AI provider list to ANY unauthenticated
 * caller. Fixed by splitting it: /api/health stays public but minimal
 * (src/app/api/health/route.ts), and the previous full detail moved to
 * /api/health/detailed (src/app/api/health/detailed/route.ts), gated by
 * requireRole('admin') and scoped to the caller's own workspace
 * (src/lib/health.ts's checkJobs(workspaceId)) — not the whole deployment,
 * since this app's role model has no "platform admin" above workspace admin.
 *
 * The detailed route needs a real Next.js request context (cookies()) to
 * authenticate — calling it directly here proves the fail-closed case (no
 * session → refused, not crashed). The "real admin session, real HTTP
 * request" success path is covered by the live-deployment smoke check,
 * which stands up a real server anyway. Real Postgres; throwaway
 * workspaces deleted in the finally block. Run via `npm run health:test`.
 */
import 'dotenv/config';
import { PrismaClient } from '../src/generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const db = new PrismaClient({ adapter });

let fails = 0;
function check(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { fails++; console.log(`FAIL ${name}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`); }
  else console.log(`pass ${name}`);
}
function checkTrue(name: string, got: boolean) { check(name, got, true); }

async function main() {
  const wsA = await db.workspace.create({ data: { name: 'Health Test A', slug: 'health-a-' + Date.now() } });
  const wsB = await db.workspace.create({ data: { name: 'Health Test B', slug: 'health-b-' + Date.now() } });

  try {
    // ═══ PUBLIC /api/health — minimal, no leak ═══
    const { GET: publicGet } = await import('../src/app/api/health/route');
    const publicRes = await publicGet();
    const publicBody = await publicRes.json();
    check('public health responds 200 when the DB is reachable', publicRes.status, 200);
    check('public health body has EXACTLY status+timestamp, nothing else', Object.keys(publicBody).sort(), ['status', 'timestamp']);
    checkTrue('public health reports status ok', publicBody.status === 'ok');
    checkTrue('public health never includes a database key at all', !('database' in publicBody));
    checkTrue('public health never includes a jobs key at all (the old cross-tenant leak)', !('jobs' in publicBody));
    checkTrue('public health never includes an ai/provider key at all', !('ai' in publicBody) && !('storage' in publicBody));

    // ═══ AUTHENTICATED /api/health/detailed — fails closed with no session ═══
    const { GET: detailedGet } = await import('../src/app/api/health/detailed/route');
    const detailedRes = await detailedGet();
    check('detailed health refuses a request with no session (401, not a crash)', detailedRes.status, 401);
    const detailedBody = await detailedRes.json();
    checkTrue('the refusal is a clean JSON error, not job/database leak', !('jobs' in detailedBody) && !('database' in detailedBody));

    // ═══ checkJobs(workspaceId) is genuinely scoped, not global ═══
    const { checkJobs, checkDatabase } = await import('../src/lib/health');

    check('checkDatabase reports the real, reachable database as ok', (await checkDatabase()).ok, true);

    await db.job.create({ data: { workspaceId: wsA.id, type: 'send_message', payload: {}, status: 'failed', lastError: 'workspace A secret failure detail' } });
    await db.job.create({ data: { workspaceId: wsB.id, type: 'send_message', payload: {}, status: 'failed', lastError: 'workspace B secret failure detail' } });
    await db.job.create({ data: { workspaceId: wsA.id, type: 'send_message', payload: {}, status: 'pending' } });

    const jobsA = await checkJobs(wsA.id);
    const jobsB = await checkJobs(wsB.id);
    check('checkJobs(A) counts exactly workspace A\'s pending job', jobsA.pending, 1);
    check('checkJobs(A) counts exactly workspace A\'s failed job', jobsA.recentFailures24h, 1);
    checkTrue('checkJobs(A) never surfaces workspace B\'s failure text', !jobsA.recentFailures.some((f) => f.lastError?.includes('workspace B')));
    check('checkJobs(B) counts exactly workspace B\'s failed job, not A\'s', jobsB.recentFailures24h, 1);
    check('checkJobs(B) sees zero pending jobs — A\'s pending job never leaks into B\'s count', jobsB.pending, 0);
    checkTrue('checkJobs(B) never surfaces workspace A\'s failure text', !jobsB.recentFailures.some((f) => f.lastError?.includes('workspace A')));

    console.log('\nall health endpoint regression checks completed');
  } finally {
    await db.workspace.deleteMany({ where: { id: { in: [wsA.id, wsB.id] } } });
  }

  console.log(fails ? `\n${fails} FAILED` : '\nall health endpoint regression tests passed');
  process.exit(fails ? 1 : 0);
}

main().finally(() => db.$disconnect());
