import { db } from '../db';
import { normalizeRow } from './parse';
import type { ColumnMap } from './mapping';
import { checkQuota, recordUsage } from '../usage/service';

/**
 * Upsert rows into Lead. Dedupe is by email, else phone, per workspace.
 * Quota is checked once against `rows.length` (the worst case — every row
 * turning into a real imported lead) before touching the database, so an
 * over-quota import is refused outright rather than partially applied; the
 * usage actually RECORDED afterward is the real `imported` count, since a
 * skipped (uncontactable) row never became a real lead.
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
  for (const row of rows) {
    const n = normalizeRow(row, map, headers, defaultCc);
    if (!n.dedupeKey) { skipped++; continue; } // not contactable by email or phone
    try {
      await db.lead.upsert({
        where: { workspaceId_dedupeKey: { workspaceId, dedupeKey: n.dedupeKey } },
        create: { workspaceId, listId, ...n, custom: n.custom as object },
        update: { listId, ...n, custom: n.custom as object },
      });
      imported++;
    } catch { skipped++; }
  }
  await db.leadList.update({ where: { id: listId }, data: { rowCount: imported } });
  if (imported > 0) await recordUsage(workspaceId, 'lead_processed', imported, { listId });
  return { imported, skipped };
}
