import { db } from '../db';
import { normalizeRow } from './parse';
import type { ColumnMap } from './mapping';

/** Upsert rows into Lead. Dedupe is by email, else phone, per workspace. */
export async function importRows(
  workspaceId: string,
  listId: string,
  rows: Record<string, string>[],
  map: ColumnMap,
  headers: string[],
  defaultCc = '',
): Promise<{ imported: number; skipped: number }> {
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
  return { imported, skipped };
}
