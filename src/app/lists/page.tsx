import { redirect } from 'next/navigation';
import Link from 'next/link';
import fs from 'node:fs/promises';
import path from 'node:path';
import { db } from '@/lib/db';
import { getSession } from '@/lib/session';
import { parseWorkbook } from '@/lib/import/parse';
import { importRows } from '@/lib/import/ingest';

export const dynamic = 'force-dynamic';

async function upload(formData: FormData) {
  'use server';
  const s = await getSession();
  if (!s) redirect('/login');

  const file = formData.get('file') as File | null;
  if (!file || !file.size) throw new Error('Choose a file');
  const defaultCc = String(formData.get('defaultCc') || '').replace(/\D/g, '');

  const buf = Buffer.from(await file.arrayBuffer());
  const parsed = await parseWorkbook(buf, file.name);
  if (!parsed.sheets.length) throw new Error('No readable sheet found in that file');

  const dir = path.join(process.cwd(), 'uploads');
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `${Date.now()}-${file.name.replace(/[^\w.\-]/g, '_')}`);
  await fs.writeFile(filePath, buf);

  const best = parsed.sheets[0];
  const rows = parsed.rowsBySheet[best.name] ?? [];

  const list = await db.leadList.create({
    data: {
      workspaceId: s.workspaceId,
      name: String(formData.get('name') || file.name.replace(/\.[^.]+$/, '')),
      sourceFile: file.name,
      filePath,
      sheetName: best.name,
      columnMap: best.map as object,
      headers: best.headers,
      sheets: parsed.sheets.map((x) => ({
        name: x.name, headers: x.headers, rowCount: x.rowCount, map: x.map, unmapped: x.unmapped,
      })) as object,
    },
  });

  await importRows(s.workspaceId, list.id, rows, best.map, best.headers, defaultCc);
  redirect(`/lists/${list.id}`);
}

export default async function Lists() {
  const s = await getSession();
  if (!s) redirect('/login');
  const lists = await db.leadList.findMany({
    where: { workspaceId: s.workspaceId },
    orderBy: { createdAt: 'desc' },
    include: { _count: { select: { leads: true } } },
  });

  return (
    <div className="space-y-8">
      <h1 className="text-2xl font-semibold">Lead lists</h1>

      <form action={upload} className="card space-y-4">
        <div className="font-medium">Import a spreadsheet</div>
        <p className="text-sm text-muted">
          .xlsx, .xls, .csv or .tsv. Every sheet is inspected, the header row is detected even when
          there are title banners above it, and columns are mapped automatically. Anything not
          recognised is still imported and stays usable as a <code className="text-slate-300">{'{{merge_tag}}'}</code>.
        </p>
        <div className="grid md:grid-cols-3 gap-4">
          <div className="md:col-span-2">
            <label className="label">File</label>
            <input className="input" type="file" name="file" accept=".xlsx,.xls,.csv,.tsv" required />
          </div>
          <div>
            <label className="label">Default country code (for phones without +)</label>
            <input className="input" name="defaultCc" placeholder="966" />
          </div>
        </div>
        <div><label className="label">List name (optional)</label><input className="input" name="name" /></div>
        <button className="btn">Import</button>
      </form>

      <div className="card p-0 overflow-hidden">
        <table className="w-full">
          <thead className="bg-ink"><tr><th className="th">List</th><th className="th">Source</th><th className="th">Sheet</th><th className="th">Leads</th></tr></thead>
          <tbody>
            {lists.map((l) => (
              <tr key={l.id}>
                <td className="td"><Link className="text-accent" href={`/lists/${l.id}`}>{l.name}</Link></td>
                <td className="td text-muted">{l.sourceFile}</td>
                <td className="td text-muted">{l.sheetName}</td>
                <td className="td">{l._count.leads}</td>
              </tr>
            ))}
            {!lists.length && <tr><td className="td text-muted" colSpan={4}>No lists yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
