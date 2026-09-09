import { db } from '../db';
import { normalizeRow } from './parse';
import type { ColumnMap } from './mapping';
import { checkQuota, recordUsage } from '../usage/service';

// Bounded, not unlimited: stays comfortably under pg.Pool's default max (10,
// src/lib/db.ts) with headroom for whatever else the same process is doing.
const IMPORT_CONCURRENCY = Number(process.env.IMPORT_CONCURRENCY ?? 8);

/**
 * Upsert rows into Lead. Dedupe is by email, else phone, per workspace.
 * Quota is checked once against `rows.length` (the worst case — every row
 * turning into a real imported lead) before touching the database, so an
 * over-quota import is refused outright rather than partially applied; the
 * usage actually RECORDED afterward is the real `imported` count, since a
 * skipped (uncontactable) row never became a real lead.
 *
 * Chunked with bounded concurrency, not one sequential upsert per row: this
 * app's own quotas allow importing up to 500k rows in one call
 * (src/lib/usage/plans.ts) from a single spreadsheet upload
 * (src/app/lists/[id]/page.tsx's `reimport` Server Action), all awaited
 * inline in one HTTP request — a real request-timeout risk at that scale.
 * Per-row skip semantics (no dedupeKey, or the upsert itself fails) are
 * unchanged; only the round-trip is batched, not the decision logic.
 */
export async function importRows(
  workspaceId: string,
  listId: string,
  rows: Record<string, string>[],
  map: ColumnMap,
  headers: string[],
  defaultCc = '',
): Promise<{ imported: number; skipped: number }> {
  await checkQuota(workspaceId, 'lead_processed', rows.length);
  let imported = 0, skipped = 0;

  for (let i = 0; i < rows.length; i += IMPORT_CONCURRENCY) {
    const chunk = rows.slice(i, i + IMPORT_CONCURRENCY);
    const normalized = chunk.map((row) => normalizeRow(row, map, headers, defaultCc));
    const contactable = normalized.filter((n) => {
      if (n.dedupeKey) return true;
      skipped++; // not contactable by email or phone — never attempted, same as before
      return false;
    });

    // Two rows sharing a dedupeKey (a spreadsheet with a real duplicate) MUST
    // resolve in original order, last one wins — the same guarantee a plain
    // sequential loop gives for free. Upserting them concurrently is a
    // genuine race with no deterministic winner (confirmed by
    // scripts/import-batch-test.ts before this fix: which row's data
    // survived depended on which concurrent upsert happened to commit
    // last, not on row order). Grouping by key and running each group's
    // upserts sequentially — while different keys' groups still run fully
    // concurrently with each other — keeps the batching win for the
    // realistic case (nearly every row has a distinct key) without losing
    // that guarantee for the rare collision.
    const groups = new Map<string, typeof contactable>();
    for (const n of contactable) {
      const key = n.dedupeKey!;
      const group = groups.get(key);
      if (group) group.push(n); else groups.set(key, [n]);
    }

    const groupResults = await Promise.all([...groups.values()].map(async (group) => {
      const outcomes: boolean[] = [];
      for (const n of group) {
        try {
          await db.lead.upsert({
            where: { workspaceId_dedupeKey: { workspaceId, dedupeKey: n.dedupeKey! } },
            create: { workspaceId, listId, ...n, custom: n.custom as object },
            update: { listId, ...n, custom: n.custom as object },
          });
          outcomes.push(true);
        } catch {
          outcomes.push(false);
        }
      }
      return outcomes;
    }));
    for (const outcomes of groupResults) {
      for (const ok of outcomes) { if (ok) imported++; else skipped++; }
    }
  }

  await db.leadList.update({ where: { id: listId }, data: { rowCount: imported } });
  if (imported > 0) await recordUsage(workspaceId, 'lead_processed', imported, { listId });
  return { imported, skipped };
}
