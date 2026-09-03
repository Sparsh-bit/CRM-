import { redirect } from 'next/navigation';
import Link from 'next/link';
import fs from 'node:fs/promises';
import { db } from '@/lib/db';
import { getSession } from '@/lib/session';
import { parseWorkbook } from '@/lib/import/parse';
import { importRows } from '@/lib/import/ingest';
import { CANONICAL } from '@/lib/import/mapping';

export const dynamic = 'force-dynamic';

type SheetMeta = { name: string; headers: string[]; rowCount: number; map: Record<string, string>; unmapped: string[] };

async function reimport(formData: FormData) {
  'use server';
  const s = await getSession();
  if (!s) redirect('/login');
  const listId = String(formData.get('listId'));
  const list = await db.leadList.findFirstOrThrow({ where: { id: listId, workspaceId: s.workspaceId } });
  if (!list.filePath) throw new Error('Original file is no longer on disk — re-upload it');

  const buf = await fs.readFile(list.filePath);
  const parsed = await parseWorkbook(buf, list.sourceFile ?? 'file.xlsx');
  const sheetName = String(formData.get('sheet') || list.sheetName);
  const sheet = parsed.sheets.find((x) => x.name === sheetName);
  if (!sheet) throw new Error(`Sheet "${sheetName}" not found`);

  // Manual overrides beat the auto-map.
  const map: Record<string, string> = {};
  for (const f of CANONICAL) {
    const v = String(formData.get(`map_${f}`) || '');
    if (v) map[f] = v;
  }

  const rows = parsed.rowsBySheet[sheetName] ?? [];
  await db.leadList.update({
    where: { id: listId },
    data: { sheetName, columnMap: map as object, headers: sheet.headers },
  });
  await importRows(s.workspaceId, listId, rows, map, sheet.headers, String(formData.get('defaultCc') || ''));
  redirect(`/lists/${listId}`);
}

export default async function ListDetail({ params }: { params: Promise<{ id: string }> }) {
  const s = await getSession();
  if (!s) redirect('/login');
  const { id } = await params;

  const list = await db.leadList.findFirstOrThrow({
    where: { id, workspaceId: s.workspaceId },
  });
  const leads = await db.lead.findMany({ where: { listId: id }, take: 100, orderBy: { createdAt: 'asc' } });
  const total = await db.lead.count({ where: { listId: id } });
  const withEmail = await db.lead.count({ where: { listId: id, emailValid: true } });
  const withPhone = await db.lead.count({ where: { listId: id, phone: { not: null } } });

  const sheets = (list.sheets ?? []) as unknown as SheetMeta[];
  const current = sheets.find((x) => x.name === list.sheetName) ?? sheets[0];
  const map = (list.columnMap ?? {}) as Record<string, string>;
  const headers = (list.headers ?? []) as string[];
  const customKeys = [...new Set(leads.flatMap((l) => Object.keys((l.custom ?? {}) as object)))];

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">{list.name}</h1>
          <div className="text-sm text-muted mt-1">
            {total} leads · {withEmail} emailable · {withPhone} with WhatsApp numbers · sheet “{list.sheetName}”
          </div>
        </div>
        <Link href={`/campaigns?list=${list.id}`} className="btn">Create campaign</Link>
      </div>

      <div className="card">
        <div className="font-medium mb-3">Sheets found in this workbook</div>
        <div className="grid md:grid-cols-2 gap-3">
          {sheets.map((sh) => (
            <div key={sh.name} className={`rounded-lg border p-3 ${sh.name === list.sheetName ? 'border-accent' : 'border-line'}`}>
              <div className="flex justify-between items-baseline">
                <span className="font-medium text-sm">{sh.name}</span>
                <span className="text-xs text-muted">{sh.rowCount} rows · {sh.headers.length} cols</span>
              </div>
              <div className="text-xs text-muted mt-1.5">
                mapped: {Object.keys(sh.map).join(', ') || 'none'}
              </div>
              {sh.unmapped.length > 0 && (
                <div className="text-xs text-muted mt-1">kept as custom: {sh.unmapped.slice(0, 8).join(', ')}{sh.unmapped.length > 8 ? ` +${sh.unmapped.length - 8}` : ''}</div>
              )}
            </div>
          ))}
        </div>
      </div>

      <form action={reimport} className="card space-y-4">
        <div className="font-medium">Column mapping</div>
        <p className="text-sm text-muted">Change a sheet or fix a column, then re-import. Existing leads are updated, not duplicated.</p>
        <input type="hidden" name="listId" value={list.id} />
        <div className="grid md:grid-cols-3 gap-4">
          <div>
            <label className="label">Sheet</label>
            <select className="input" name="sheet" defaultValue={list.sheetName ?? ''}>
              {sheets.map((sh) => <option key={sh.name} value={sh.name}>{sh.name}</option>)}
            </select>
          </div>
          <div><label className="label">Default country code</label><input className="input" name="defaultCc" placeholder="966" /></div>
        </div>
        <div className="grid md:grid-cols-3 gap-3">
          {CANONICAL.map((f) => (
            <div key={f}>
              <label className="label">{f}</label>
              <select className="input" name={`map_${f}`} defaultValue={map[f] ?? ''}>
                <option value="">— not mapped —</option>
                {(current?.headers ?? headers).map((h) => <option key={h} value={h}>{h}</option>)}
              </select>
            </div>
          ))}
        </div>
        <button className="btn">Re-import with this mapping</button>
      </form>

      {customKeys.length > 0 && (
        <div className="card">
          <div className="font-medium mb-2">Extra columns kept from the sheet</div>
          <p className="text-sm text-muted mb-3">Use any of these in a template, and the AI writer reads all of them as context.</p>
          <div className="flex flex-wrap gap-1.5">
            {customKeys.map((k) => (
              <code key={k} className="pill bg-line text-slate-300">
                {'{{' + k.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') + '}}'}
              </code>
            ))}
          </div>
        </div>
      )}

      <div className="card p-0 overflow-x-auto">
        <table className="w-full">
          <thead className="bg-ink">
            <tr>
              {['Company', 'Contact', 'Role', 'Email', 'Phone', 'Industry', 'City', 'Tier', 'Status'].map((h) => <th key={h} className="th">{h}</th>)}
            </tr>
          </thead>
          <tbody>
            {leads.map((l) => (
              <tr key={l.id}>
                <td className="td">{l.company ?? '—'}</td>
                <td className="td">{l.fullName ?? l.firstName ?? '—'}</td>
                <td className="td text-muted">{l.title ?? '—'}</td>
                <td className={`td ${l.emailValid ? '' : 'text-warn'}`}>{l.email ?? '—'}</td>
                <td className="td">{l.phone ?? '—'}</td>
                <td className="td text-muted">{l.industry ?? '—'}</td>
                <td className="td text-muted">{l.city ?? '—'}</td>
                <td className="td text-muted">{l.tier ?? '—'}</td>
                <td className="td">{l.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {total > 100 && <div className="text-xs text-muted">Showing the first 100 of {total}.</div>}
    </div>
  );
}
