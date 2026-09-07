/**
 * Regression tests for two real bugs a peer session's audit found (neither
 * had any test coverage before, which is partly why both went unnoticed
 * across three prior hardening passes):
 *  1. Open redirect: src/app/api/t/c/[tid]/route.ts used to redirect to ANY
 *     `u` param with an http(s) scheme, unconditionally — src/lib/email/
 *     tracking.ts's signClickUrl/verifyClickUrl now ties a redirect target
 *     to the exact trackingId it was generated for.
 *  2. Fail-open webhook auth: src/app/api/webhooks/evolution/route.ts used
 *     to accept every request when EVOLUTION_WEBHOOK_SECRET was unset.
 * No database needed — both are pure-logic/route-handler checks. Run
 * separately from `npm test` via `npm run security-fixes:test`.
 */
import 'dotenv/config';
(process.env as Record<string, string>).AUTH_SECRET = 'x'.repeat(40);

import { signClickUrl, verifyClickUrl } from '../src/lib/email/tracking';

let fails = 0;
function check(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { fails++; console.log(`FAIL ${name}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`); }
  else console.log(`pass ${name}`);
}

async function main() {
  // ═══ Click-URL signing (the open-redirect fix) ═══
  const sig = signClickUrl('tid-1', 'https://example.com/real-link');
  check('a correctly signed (trackingId, url) pair verifies', verifyClickUrl('tid-1', 'https://example.com/real-link', sig), true);
  check('the same signature does NOT verify for a different trackingId (a forged/reused sig)', verifyClickUrl('tid-2', 'https://example.com/real-link', sig), false);
  check('the same signature does NOT verify for a different url (the open-redirect case — attacker swaps the destination)', verifyClickUrl('tid-1', 'https://evil.example/phish', sig), false);
  check('a missing signature never verifies', verifyClickUrl('tid-1', 'https://example.com/real-link', null), false);
  check('a garbage signature never verifies', verifyClickUrl('tid-1', 'https://example.com/real-link', 'not-a-real-signature'), false);

  // ═══ Evolution webhook fail-closed (the auth-bypass fix) ═══
  delete process.env.EVOLUTION_WEBHOOK_SECRET;
  const { POST } = await import('../src/app/api/webhooks/evolution/route');
  const reqNoSecret = new Request('http://localhost/api/webhooks/evolution', { method: 'POST', body: JSON.stringify({}) });
  const resNoSecretConfigured = await POST(reqNoSecret);
  check('with EVOLUTION_WEBHOOK_SECRET unset, the webhook now refuses every request (was: accepted everything)', resNoSecretConfigured.status, 403);

  process.env.EVOLUTION_WEBHOOK_SECRET = 'real-secret';
  const reqWrongSecret = new Request('http://localhost/api/webhooks/evolution?secret=wrong', { method: 'POST', body: JSON.stringify({}) });
  const resWrongSecret = await POST(reqWrongSecret);
  check('with a secret configured, a mismatched one is still refused', resWrongSecret.status, 403);

  const reqRightSecret = new Request('http://localhost/api/webhooks/evolution?secret=real-secret', { method: 'POST', body: JSON.stringify({ event: 'unknown.event' }) });
  const resRightSecret = await POST(reqRightSecret);
  check('with the correct secret, the request is accepted', resRightSecret.status, 200);

  console.log(fails ? `\n${fails} FAILED` : '\nsecurity fixes regression test passed');
  process.exit(fails ? 1 : 0);
}

main();
