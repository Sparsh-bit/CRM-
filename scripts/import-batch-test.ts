/**
 * Regression test for importRows()'s N+1 fix (src/lib/import/ingest.ts)
 * found in a production-reliability audit: the old version awaited one
 * db.lead.upsert() per spreadsheet row, sequentially, inside a plain loop —
 * this app's own quotas allow importing up to 500k rows in one call
 * (src/lib/usage/plans.ts) from a single upload/reimport Server Action, a
 * real request-timeout risk. Fixed with bounded-concurrency chunking; the
 * per-row skip semantics (no dedupeKey, or the upsert itself fails) are
 * unchanged. IMPORT_CONCURRENCY is read once at module load (see the
 * dynamic import below, same reason db-singleton-test.ts does this), set
 * small here to force several chunk boundaries with a modest row count.
 * Real Postgres; throwaway workspace deleted in the finally block.
 * Run via `npm run import-batch:test`.
 */
import 'dotenv/config';
process.env.IMPORT_CONCURRENCY = '4';

import { PrismaClient } from '../src/generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import type { ColumnMap } from '../src/lib/import/mapping';

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const db = new PrismaClient({ adapter });

let fails = 0;
function check(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { fails++; console.log(`FAIL ${name}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`); }
  else console.log(`pass ${name}`);
}

async function main() {
  const { importRows } = await import('../src/lib/import/ingest'); // AFTER IMPORT_CONCURRENCY is set above

  const ws = await db.workspace.create({ data: { name: 'Import Batch Test', slug: 'import-batch-' + Date.now() } });

  try {
    const list = await db.leadList.create({ data: { workspaceId: ws.id, name: 'L' } });
    const map: ColumnMap = { email: 'Email', fullName: 'Name' };
    const headers = ['Email', 'Name'];

    // 15 rows across a concurrency of 4 -> forces multiple chunk boundaries
    // (4,4,4,3), not a single batch — proves chunking is correct at the edges,
    // not just within one chunk.
    const uniqueRows = Array.from({ length: 15 }, (_, i) => ({ Email: `batch-lead-${i}-${Date.now()}@test.local`, Name: `Lead ${i}` }));
    const uncontactableRows = [{ Email: '', Name: 'No Contact Info' }, { Email: '', Name: 'Also No Contact Info' }];
    const dupeEmail = `dupe-${Date.now()}@test.local`;
    const duplicateRows = [{ Email: dupeEmail, Name: 'First' }, { Email: dupeEmail, Name: 'Second (same email)' }];

    const rows = [...uniqueRows, ...uncontactableRows, ...duplicateRows];
    const result = await importRows(ws.id, list.id, rows, map, headers);

    check('every uncontactable row (no dedupe key) is skipped, never attempted against the DB', result.skipped, 2);
    check('every contactable row (unique + duplicate pair) is counted imported, matching pre-fix per-row semantics', result.imported, uniqueRows.length + duplicateRows.length);

    const createdUniqueCount = await db.lead.count({ where: { workspaceId: ws.id, email: { in: uniqueRows.map((r) => r.Email) } } });
    check('every unique-email row became its own real Lead', createdUniqueCount, uniqueRows.length);

    const dupeLeads = await db.lead.findMany({ where: { workspaceId: ws.id, email: dupeEmail } });
    check('two rows with the SAME email upsert to exactly ONE Lead row (dedupe holds across chunk boundaries)', dupeLeads.length, 1);
    check('the later row\'s data won the upsert (update, not a second create)', dupeLeads[0]?.fullName, 'Second (same email)');

    check('leadList.rowCount reflects the real imported count', (await db.leadList.findUniqueOrThrow({ where: { id: list.id } })).rowCount, result.imported);

    console.log('\nall import batch regression checks completed');
  } finally {
    await db.workspace.delete({ where: { id: ws.id } });
  }

  console.log(fails ? `\n${fails} FAILED` : '\nall import batch regression tests passed');
  process.exit(fails ? 1 : 0);
}

main().finally(() => db.$disconnect());
