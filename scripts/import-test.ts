/**
 * Verifies the importer against a real workbook, with no database.
 *   npx tsx scripts/import-test.ts samples/Outreach_Kit_Tier13.xlsx
 */
import fs from 'node:fs';
import { parseWorkbook, normalizeRow } from '../src/lib/import/parse';
import { render } from '../src/lib/template';

const file = process.argv[2] ?? 'samples/Outreach_Kit_Tier13.xlsx';
const buf = fs.readFileSync(file);

const bar = (s: string) => console.log('\n' + s + '\n' + '─'.repeat(78));

(async () => {
  const parsed = await parseWorkbook(buf, file);

  bar(`SHEETS DETECTED: ${parsed.sheets.length}  (ranked by contactable rows)`);
  for (const s of parsed.sheets) {
    console.log(`• ${s.name}`);
    console.log(`    header row : ${s.headerRow}`);
    console.log(`    columns    : ${s.headers.length} → ${s.headers.join(' | ')}`);
    console.log(`    data rows  : ${s.rowCount}`);
    console.log(`    mapped     : ${Object.entries(s.map).map(([k, v]) => `${k}="${v}"`).join(', ') || '(none)'}`);
    console.log(`    kept custom: ${s.unmapped.join(', ') || '(none)'}`);
  }

  const best = parsed.sheets[0];
  const rows = parsed.rowsBySheet[best.name];
  const leads = rows.map((r) => normalizeRow(r, best.map, best.headers, '966'));

  bar(`NORMALIZED FROM "${best.name}"`);
  const emailable = leads.filter((l) => l.emailValid).length;
  const phoneable = leads.filter((l) => l.phone).length;
  const contactable = leads.filter((l) => l.dedupeKey).length;
  const named = leads.filter((l) => l.firstName).length;
  console.log(`rows ${leads.length} · valid email ${emailable} · usable phone ${phoneable} · contactable ${contactable} · first name resolved ${named}`);
  console.log(`unique dedupe keys: ${new Set(leads.map((l) => l.dedupeKey)).size}`);

  bar('SAMPLE LEADS');
  for (const l of [leads[0], leads[Math.floor(leads.length / 2)], leads[leads.length - 1]]) {
    console.log({
      company: l.company, contact: l.fullName, first: l.firstName, title: l.title,
      email: l.email, phone: l.phone, industry: l.industry, city: l.city,
      country: l.country, tier: l.tier, customKeys: Object.keys(l.custom),
    });
  }

  bar('MERGE-TAG RENDER (template mode)');
  const tpl = `Hi {{first_name | fallback: "there"}},

I'm Krishna from Concilio. We build custom software and AI agents for {{industry | fallback: "businesses"}} companies in {{country}}.

For {{company}}, the angle we'd start from is: {{pitch | fallback: "your operations workflow"}}.

Worth 15 minutes?

Krishna`;
  for (const l of [leads[0], leads[30] ?? leads[1]]) {
    const ctx = {
      first_name: l.firstName, company: l.company, industry: l.industry,
      country: l.country, city: l.city, ...l.custom,
    };
    const r = render(tpl, ctx, l.dedupeKey ?? 'x');
    console.log('---');
    console.log(r.text);
    console.log('missing tags:', r.missing.length ? r.missing : 'none');
  }

  bar('WHAT THE AI WRITER WOULD SEE FOR ONE LEAD');
  const l = leads[0];
  console.log(JSON.stringify({
    firstName: l.firstName, fullName: l.fullName, company: l.company, title: l.title,
    industry: l.industry, city: l.city, country: l.country, tier: l.tier, custom: l.custom,
  }, null, 2));
})();
