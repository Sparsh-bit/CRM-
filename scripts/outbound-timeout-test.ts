/**
 * Regression test for two outbound-timeout gaps a provider-contract audit
 * found: the R2/S3 storage client (src/lib/storage/r2.ts) and the email
 * HTTP-API providers (Resend/Gmail/Graph/OAuth refresh, src/lib/email/
 * senders.ts) were the only outbound integrations in this codebase with NO
 * explicit timeout — every other one (AI provider router, WhatsApp's
 * evolution.ts, SMS's httpsms.ts, research's webFetch/search) already wires
 * an AbortController/requestHandler timeout so a hung connection can't
 * block a worker tick indefinitely.
 *
 * Both fixes read their timeout from env vars evaluated once at module
 * load — set small here BEFORE the dynamic imports (see db-singleton-test.ts
 * for why this has to be a dynamic import, not a static one: static imports
 * are hoisted above these assignments regardless of source order). No
 * network needed beyond a local server that never responds — no
 * credentials, no real provider touched. Run via `npm run outbound-timeout:test`.
 */
import 'dotenv/config';
process.env.STORAGE_R2_CONNECT_TIMEOUT_MS = '600';
process.env.STORAGE_R2_REQUEST_TIMEOUT_MS = '600';
process.env.EMAIL_PROVIDER_TIMEOUT_MS = '600';

import http from 'node:http';
import type { AddressInfo } from 'node:net';

let fails = 0;
function check(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { fails++; console.log(`FAIL ${name}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`); }
  else console.log(`pass ${name}`);
}
function checkTrue(name: string, got: boolean) { check(name, got, true); }

/** Accepts the connection, never sends a response — the exact shape of a hung provider connection. */
function startHungServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer(() => { /* never respond */ });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

async function main() {
  const hung = await startHungServer();

  try {
    // ═══ R2/S3 storage client: a hung connection must be refused, not left to hang ═══
    const { r2Upload } = await import('../src/lib/storage/r2');
    const cfg = { endpoint: hung.url, accessKeyId: 'test', secretAccessKey: 'test', bucket: 'test-bucket' };

    const r2Start = Date.now();
    let r2TimedOut = false;
    try {
      await r2Upload(cfg, 'test/key.txt', Buffer.from('hi'));
    } catch {
      r2TimedOut = true;
    }
    const r2Elapsed = Date.now() - r2Start;
    checkTrue('a hung R2/S3 connection is refused, not left to hang indefinitely', r2TimedOut);
    checkTrue(
      `the R2 timeout fires within a bounded window (took ${r2Elapsed}ms), not after some much longer platform default`,
      r2Elapsed < 10_000,
    );

    // ═══ Email HTTP-API providers: timedFetch must bound a hung connection the same way ═══
    const { timedFetch } = await import('../src/lib/email/senders');

    const emailStart = Date.now();
    let emailTimedOut = false;
    let emailMessage = '';
    try {
      await timedFetch(hung.url, { method: 'POST' });
    } catch (e) {
      emailTimedOut = true;
      emailMessage = e instanceof Error ? e.message : String(e);
    }
    const emailElapsed = Date.now() - emailStart;
    checkTrue('a hung email-provider connection is refused, not left to hang indefinitely', emailTimedOut);
    checkTrue('the error names it as a timeout, not a generic/ambiguous network error', /timed out/i.test(emailMessage));
    checkTrue(
      `the email timeout fires within a bounded window (took ${emailElapsed}ms), not after some much longer platform default`,
      emailElapsed < 5_000,
    );

    console.log('\nall outbound timeout regression checks completed');
  } finally {
    await hung.close();
  }

  console.log(fails ? `\n${fails} FAILED` : '\nall outbound timeout regression tests passed');
  process.exit(fails ? 1 : 0);
}

main();
