/**
 * Phase 11 production hardening: regression test for a real bug found and
 * fixed this pass — src/lib/db.ts's lazy Proxy used to skip caching the
 * built PrismaClient in production (`if (NODE_ENV !== 'production')`),
 * which meant every `db.<model>` property access opened a brand-new
 * PrismaClient + a brand-new pg.Pool (a brand-new real Postgres connection),
 * not once per process — confirmed directly against real Postgres before
 * the fix (6 property accesses -> 6 new connections) and would exhaust a
 * production database's connection limit almost immediately under real
 * traffic. This test asserts the fix holds: multiple `db.X` accesses with
 * NODE_ENV=production reuse ONE real connection, not one per access.
 * Run separately from `npm test` via `npm run db-singleton:test`.
 */
import 'dotenv/config';
// @types/node declares NODE_ENV specifically readonly; cast to a plain record to set it —
// the exact condition that exposed the bug, and it must be set before importing db.ts.
(process.env as Record<string, string>).NODE_ENV = 'production';

import { PrismaClient } from '../src/generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

let fails = 0;
function check(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { fails++; console.log(`FAIL ${name}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`); }
  else console.log(`pass ${name}`);
}

async function realConnectionCount(): Promise<number> {
  const probe = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
  try {
    const r = await probe.$queryRawUnsafe<{ count: number }[]>(
      'SELECT count(*)::int as count FROM pg_stat_activity WHERE datname = current_database()',
    );
    return r[0].count;
  } finally {
    await probe.$disconnect();
  }
}

async function main() {
  const { db } = await import('../src/lib/db'); // imported AFTER setting NODE_ENV=production above

  const before = await realConnectionCount();

  // Six distinct db.<model> property accesses, exactly the shape a single
  // real request (e.g. getOnboardingStatus) makes — each used to build a
  // fresh client before this fix.
  await db.workspace.findMany({ take: 1 });
  await db.mailbox.findMany({ take: 1 });
  await db.waInstance.findMany({ take: 1 });
  await db.smsGateway.findMany({ take: 1 });
  await db.agent.count();
  await db.agentTask.count();

  const afterFirstRound = await realConnectionCount();
  check(
    'six db.X property accesses in production open at most ONE new real connection, not six',
    afterFirstRound - before <= 1,
    true,
  );

  // A second, later round must open ZERO further connections — proves the client is actually cached, not just "better than before."
  await db.workspace.findMany({ take: 1 });
  await db.mailbox.findMany({ take: 1 });
  await db.agent.count();
  const afterSecondRound = await realConnectionCount();
  check('further db.X accesses reuse the same cached client — no additional connections', afterSecondRound, afterFirstRound);

  console.log(fails ? `\n${fails} FAILED` : '\ndb singleton regression test passed');
  process.exit(fails ? 1 : 0);
}

main();
