import ExcelJS from 'exceljs';
import Papa from 'papaparse';
import { autoMap, isValidEmail, normalizePhone, splitName, type ColumnMap } from './mapping';

export type SheetPreview = {
  name: string;
  headerRow: number;      // 1-based index of the row we treat as headers
  headers: string[];
  rowCount: number;
  sample: Record<string, string>[];
  map: ColumnMap;
  unmapped: string[];
};

function cellText(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (typeof o.text === 'string') return o.text;
    if (Array.isArray(o.richText)) return (o.richText as { text: string }[]).map((r) => r.text).join('');
    if (o.result !== undefined) return String(o.result);
    if (o.hyperlink) return String(o.hyperlink);
    if (v instanceof Date) return v.toISOString().slice(0, 10);
  }
  return String(v).trim();
}

/**
 * Real sheets have title banners and blank spacer rows above the real headers
 * (the Concilio outreach kit puts headers on row 3). Pick the first row in the
 * top 15 that has >=3 short, distinct, non-empty cells and is followed by data.
 */
function detectHeaderRow(grid: string[][]): number {
  let best = 1, bestScore = -1;
  for (let i = 0; i < Math.min(15, grid.length); i++) {
    const row = grid[i] ?? [];
    const filled = row.filter((c) => c && c.length > 0 && c.length <= 60);
    const distinct = new Set(filled.map((c) => c.toLowerCase())).size;
    const next = grid[i + 1] ?? [];
    const nextFilled = next.filter((c) => c && c.length > 0).length;
    if (filled.length < 3 || nextFilled < 2) continue;
    const s = distinct * 2 + Math.min(filled.length, 20) - i;
    if (s > bestScore) { bestScore = s; best = i + 1; }
  }
  return best;
}

function gridToPreview(name: string, grid: string[][]): SheetPreview | null {
  if (!grid.length) return null;
  const headerRow = detectHeaderRow(grid);
  const rawHeaders = grid[headerRow - 1] ?? [];

  const headers: string[] = [];
  const seen = new Map<string, number>();
  rawHeaders.forEach((h, i) => {
    let name = (h || `column_${i + 1}`).trim() || `column_${i + 1}`;
    const n = seen.get(name) ?? 0;
    seen.set(name, n + 1);
    if (n > 0) name = `${name} (${n + 1})`;
    headers.push(name);
  });

  const dataRows = grid.slice(headerRow).filter((r) => r.some((c) => c && c.length));
  const rows = dataRows.map((r) => {
    const o: Record<string, string> = {};
    headers.forEach((h, i) => { o[h] = r[i] ?? ''; });
    return o;
  });

  if (!rows.length) return null;
  const { map, unmapped } = autoMap(headers);
  return { name, headerRow, headers, rowCount: rows.length, sample: rows.slice(0, 5), map, unmapped };
}

export type ParsedFile = { sheets: SheetPreview[]; rowsBySheet: Record<string, Record<string, string>[]> };

export async function parseWorkbook(buf: Buffer, filename: string): Promise<ParsedFile> {
  const sheets: SheetPreview[] = [];
  const rowsBySheet: Record<string, Record<string, string>[]> = {};

  if (/\.csv$/i.test(filename) || /\.tsv$/i.test(filename)) {
    const parsed = Papa.parse<string[]>(buf.toString('utf8'), { skipEmptyLines: false });
    const grid = (parsed.data as string[][]).map((r) => r.map((c) => (c ?? '').trim()));
    const p = gridToPreview('CSV', grid);
    if (p) {
      sheets.push(p);
      rowsBySheet['CSV'] = grid.slice(p.headerRow)
        .filter((r) => r.some((c) => c))
        .map((r) => Object.fromEntries(p.headers.map((h, i) => [h, r[i] ?? ''])));
    }
    return { sheets, rowsBySheet };
  }

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);

  // EVERY sheet is inspected — not just the first one.
  for (const ws of wb.worksheets) {
    const grid: string[][] = [];
    ws.eachRow({ includeEmpty: true }, (row) => {
      const vals = row.values as unknown[];
      grid.push(vals.slice(1).map(cellText));
    });
    const p = gridToPreview(ws.name, grid);
    if (!p) continue;
    sheets.push(p);
    rowsBySheet[ws.name] = grid.slice(p.headerRow)
      .filter((r) => r.some((c) => c && c.length))
      .map((r) => Object.fromEntries(p.headers.map((h, i) => [h, r[i] ?? ''])));
  }

  // Best guess first: the sheet with the most contactable rows.
  sheets.sort((a, b) => contactScore(b, rowsBySheet[b.name]) - contactScore(a, rowsBySheet[a.name]));
  return { sheets, rowsBySheet };
}

function contactScore(s: SheetPreview, rows: Record<string, string>[] = []): number {
  const emailCol = s.map.email, phoneCol = s.map.phone;
  if (!emailCol && !phoneCol) return 0;
  let n = 0;
  for (const r of rows) {
    if (emailCol && isValidEmail(r[emailCol])) n++;
    else if (phoneCol && normalizePhone(r[phoneCol], '')) n++;
  }
  return n;
}

export type NormalizedLead = {
  firstName: string | null; lastName: string | null; fullName: string | null;
  email: string | null; phone: string | null; company: string | null; title: string | null;
  industry: string | null; city: string | null; country: string | null;
  website: string | null; linkedin: string | null; tier: string | null;
  custom: Record<string, string>;
  emailValid: boolean; dedupeKey: string | null;
};

/** Row → Lead. Unmapped columns are preserved so nothing from the sheet is lost. */
export function normalizeRow(
  row: Record<string, string>,
  map: ColumnMap,
  headers: string[],
  defaultCc = '',
): NormalizedLead {
  const get = (f: keyof ColumnMap) => {
    const col = map[f];
    const v = col ? (row[col] ?? '').trim() : '';
    return v || null;
  };

  const fullName = get('fullName');
  let firstName = get('firstName');
  let lastName = get('lastName');
  if (!firstName && fullName) {
    const s = splitName(fullName);
    firstName = s.firstName || null;
    lastName = lastName || s.lastName || null;
  }

  const email = get('email');
  const phone = normalizePhone(get('phone'), defaultCc);

  const mappedCols = new Set(Object.values(map).filter(Boolean) as string[]);
  const custom: Record<string, string> = {};
  for (const h of headers) {
    if (mappedCols.has(h)) continue;
    const v = (row[h] ?? '').trim();
    if (v) custom[h] = v;
  }

  return {
    firstName, lastName, fullName,
    email: email ? email.toLowerCase() : null,
    phone,
    company: get('company'), title: get('title'), industry: get('industry'),
    city: get('city'), country: get('country'), website: get('website'),
    linkedin: get('linkedin'), tier: get('tier'),
    custom,
    emailValid: email ? isValidEmail(email) : false,
    dedupeKey: email ? email.toLowerCase() : phone,
  };
}
