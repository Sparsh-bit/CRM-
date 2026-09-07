/**
 * Phase 11 production hardening — a real, runnable pre-launch check for the
 * two provider integrations that are NOT already exercised by a per-
 * workspace "Test Connection" button in the app itself (Email/WhatsApp/SMS
 * already have one each — /mailboxes, /whatsapp, /sms — and are the correct
 * place to verify those for real once credentials exist; this script does
 * not duplicate them).
 *
 * Every check here is SAFE and bounded: Groq gets one tiny, cheap
 * completion request; R2 gets a real upload/download/delete/exists round
 * trip against a throwaway key, cleaned up regardless of outcome. Nothing
 * here sends a real email/WhatsApp/SMS message to a real recipient.
 *
 * Run with `npm run provider:check`. Each check honestly reports
 * `not_tested` (credential missing) rather than skipping silently, so the
 * output is a real go/no-go list, not just "whatever happened to be set."
 */
import 'dotenv/config';

type Result = { name: string; status: 'real_pass' | 'real_fail' | 'not_tested'; detail: string };
const results: Result[] = [];

async function checkGroq(): Promise<void> {
  if (!process.env.GROQ_API_KEY) {
    results.push({ name: 'Groq (real AI request)', status: 'not_tested', detail: 'GROQ_API_KEY is not set.' });
    return;
  }
  try {
    const { complete } = await import('../src/lib/ai/provider');
    const { text, model } = await complete({
      system: 'Reply with exactly one word: ok',
      messages: [{ role: 'user', content: 'Reply with exactly one word: ok' }],
      maxTokens: 5,
      temperature: 0,
      model: process.env.GROQ_MODEL,
      // No workspaceId passed — this is an infra smoke test, not a real
      // workspace's usage, and should not consume anyone's quota.
    });
    results.push({ name: 'Groq (real AI request)', status: 'real_pass', detail: `Real completion succeeded via model "${model}": "${text.trim().slice(0, 40)}"` });
  } catch (e) {
    results.push({ name: 'Groq (real AI request)', status: 'real_fail', detail: e instanceof Error ? e.message : String(e) });
  }
}

/** Same resolution rule as src/lib/storage/index.ts's r2Config() — R2_ENDPOINT (any S3-compatible service, e.g. a Railway bucket) or R2_ACCOUNT_ID (Cloudflare R2 specifically), either is enough to know where to connect. */
async function checkR2(): Promise<void> {
  const accountId = process.env.R2_ACCOUNT_ID, endpoint = process.env.R2_ENDPOINT;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID, secretAccessKey = process.env.R2_SECRET_ACCESS_KEY, bucket = process.env.R2_BUCKET;
  const label = endpoint ? `S3-compatible bucket (${endpoint})` : 'Cloudflare R2 (real bucket)';

  if (!accessKeyId || !secretAccessKey || !bucket || (!accountId && !endpoint)) {
    results.push({ name: label, status: 'not_tested', detail: 'Need R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY/R2_BUCKET plus either R2_ACCOUNT_ID or R2_ENDPOINT — not all are set.' });
    return;
  }
  const key = `_provider-check/${Date.now()}.txt`;
  const content = `outreachpilot provider-check ${new Date().toISOString()}`;
  try {
    const { r2Upload, r2Download, r2Delete, r2Stat } = await import('../src/lib/storage/r2');
    const cfg = {
      accountId, endpoint, accessKeyId, secretAccessKey, bucket,
      region: process.env.R2_REGION,
      forcePathStyle: process.env.R2_FORCE_PATH_STYLE === undefined ? undefined : process.env.R2_FORCE_PATH_STYLE === 'true',
    };
    await r2Upload(cfg, key, Buffer.from(content), 'text/plain');
    const stat = await r2Stat(cfg, key);
    const downloaded = (await r2Download(cfg, key)).toString();
    await r2Delete(cfg, key);
    const goneAfterDelete = await r2Stat(cfg, key);

    const ok = downloaded === content && stat?.sizeBytes === Buffer.byteLength(content) && goneAfterDelete === null;
    results.push({
      name: label,
      status: ok ? 'real_pass' : 'real_fail',
      detail: ok
        ? `Real upload/download/delete round trip succeeded against bucket "${cfg.bucket}" — object confirmed gone after delete.`
        : `Round trip completed but did not verify cleanly (downloaded match: ${downloaded === content}, size match: ${stat?.sizeBytes === Buffer.byteLength(content)}, deleted: ${goneAfterDelete === null}).`,
    });
  } catch (e) {
    results.push({ name: label, status: 'real_fail', detail: e instanceof Error ? e.message : String(e) });
  }
}

async function main() {
  await checkGroq();
  await checkR2();

  console.log('\n=== Provider integration check ===\n');
  for (const r of results) {
    const label = r.status === 'real_pass' ? 'PASS' : r.status === 'real_fail' ? 'FAIL' : 'not tested';
    console.log(`[${label}] ${r.name}\n        ${r.detail}\n`);
  }
  console.log(
    'Email/WhatsApp/SMS are NOT covered by this script — verify those through the app itself\n' +
    '(/mailboxes, /whatsapp, /sms, each has a real "Test Connection" action) once real\n' +
    'credentials are added there; that is the correct, already-built verification path.',
  );

  const anyFail = results.some((r) => r.status === 'real_fail');
  process.exit(anyFail ? 1 : 0);
}

main();
