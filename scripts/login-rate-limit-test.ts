/**
 * Regression test for the login abuse-protection gap a security audit
 * found: src/app/login/page.tsx had no attempt limit at all, and an
 * unrecognized email silently provisions a new user + workspace — making
 * the endpoint both a password-brute-force target and a resource-
 * exhaustion target (every attempt can create a real database row). Fixed
 * with src/lib/auth/rateLimit.ts's checkLoginRateLimit(), wired into
 * submit() before any user lookup/creation happens, keyed independently by
 * normalized email AND by client IP.
 *
 * WINDOW_MS/MAX_ATTEMPTS are read from env ONCE at module import — set
 * them small here so the whole file runs in well under a second, not the
 * 15-minute/20-attempt production defaults. Real Postgres; every row this
 * test creates (LoginAttempt buckets, users, workspaces) is deleted in the
 * finally block. Run via `npm run login-rate-limit:test`.
 */
import 'dotenv/config';
// 2s, not a few hundred ms: real bcrypt (cost 10) hash/compare calls inside
// simulateSubmit below take real wall-clock time (tens to ~100ms each), and a
// too-short window would expire and silently reset mid-scenario, making the
// window look "fresh" instead of exhausted — a false pass, not a real one.
process.env.LOGIN_RATE_LIMIT_WINDOW_MS = '2000';
process.env.LOGIN_RATE_LIMIT_MAX_ATTEMPTS = '3';

import { PrismaClient } from '../src/generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import bcrypt from 'bcryptjs';
// NOT a static top-level import: rateLimit.ts reads WINDOW_MS/MAX_ATTEMPTS as
// module-level consts, and static imports are hoisted above the env
// assignments above regardless of source order (the exact reason
// db-singleton-test.ts imports src/lib/db this same way). Assigned inside
// main(), after the env vars above are already set.
let checkLoginRateLimit: typeof import('../src/lib/auth/rateLimit').checkLoginRateLimit;
let RateLimitedError: typeof import('../src/lib/auth/rateLimit').RateLimitedError;

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const db = new PrismaClient({ adapter });

let fails = 0;
function check(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { fails++; console.log(`FAIL ${name}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`); }
  else console.log(`pass ${name}`);
}
async function checkThrowsRateLimited(name: string, fn: () => Promise<unknown>) {
  try { await fn(); fails++; console.log(`FAIL ${name}\n  expected RateLimitedError, got none`); }
  catch (e) {
    if (e instanceof RateLimitedError) console.log(`pass ${name}`);
    else { fails++; console.log(`FAIL ${name}\n  threw, but not RateLimitedError: ${e instanceof Error ? e.message : String(e)}`); }
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const createdUserIds: string[] = [];
const createdWorkspaceIds: string[] = [];
const usedIdentifiers = new Set<string>();
function ident(kind: 'email' | 'ip', v: string) { const s = `${kind}:${v}`; usedIdentifiers.add(s); return s; }

/** Mirrors src/app/login/page.tsx's submit() business logic exactly, minus the Next.js-only cookies()/redirect() calls that require a real request context. */
async function simulateSubmit(email: string, password: string, ip: string): Promise<'created' | 'logged_in' | 'wrong_password'> {
  await checkLoginRateLimit(ident('email', email));
  await checkLoginRateLimit(ident('ip', ip));

  const user = await db.user.findUnique({ where: { email } });
  if (!user) {
    const hash = await bcrypt.hash(password, 10);
    const created = await db.user.create({ data: { email, passwordHash: hash } });
    const ws = await db.workspace.create({
      data: { name: email, slug: 'login-rl-' + Math.random().toString(36).slice(2, 10), members: { create: { userId: created.id, role: 'owner' } } },
    });
    createdUserIds.push(created.id);
    createdWorkspaceIds.push(ws.id);
    return 'created';
  }
  const ok = await bcrypt.compare(password, user.passwordHash);
  return ok ? 'logged_in' : 'wrong_password';
}

async function main() {
  ({ checkLoginRateLimit, RateLimitedError } = await import('../src/lib/auth/rateLimit'));
  try {
    // ═══ core mechanism: normal cadence, exhaustion, isolation, reset ═══
    const mechId = `mech-${Date.now()}@test.local`;
    for (let i = 0; i < 3; i++) await checkLoginRateLimit(ident('email', mechId));
    console.log('pass 3 normal-cadence attempts within the window all succeed');
    await checkThrowsRateLimited('a 4th attempt within the same window is rate-limited', () => checkLoginRateLimit(ident('email', mechId)));

    const otherId = `mech-other-${Date.now()}`;
    await checkLoginRateLimit(ident('ip', otherId)); // must not throw — a different identifier's bucket is untouched
    console.log('pass a different identifier\'s bucket is unaffected by another identifier being exhausted');

    await sleep(2100);
    await checkLoginRateLimit(ident('email', mechId)); // must not throw now — the window has expired and reset
    console.log('pass after the window expires, the identifier resets and accepts an attempt again');

    // ═══ normal signup still works — one attempt, no rate-limit interference ═══
    const signupEmail = `signup-${Date.now()}@test.local`;
    const signupResult = await simulateSubmit(signupEmail, 'a-real-password', `ip-signup-${Date.now()}`);
    check('a normal signup (unknown email) creates the account', signupResult, 'created');
    check('exactly one user was created for the signup', await db.user.count({ where: { email: signupEmail } }), 1);

    // ═══ normal login still works — same email, correct password, on a fresh identifier ═══
    const loginEmail = `login-${Date.now()}@test.local`;
    const loginIp = `ip-login-${Date.now()}`;
    const created = await simulateSubmit(loginEmail, 'correct-password', loginIp);
    check('setup: signup for the login scenario succeeds', created, 'created');
    const loggedIn = await simulateSubmit(loginEmail, 'correct-password', loginIp);
    check('a normal login (existing email, correct password) succeeds', loggedIn, 'logged_in');

    // ═══ repeated failed attempts against one account get capped, not just refused on password ═══
    const bruteEmail = `brute-${Date.now()}@test.local`;
    const bruteIp = `ip-brute-${Date.now()}`;
    check('setup: account exists for the brute-force scenario', await simulateSubmit(bruteEmail, 'the-real-password', bruteIp), 'created');
    check('wrong-password attempt 1 is refused on credentials, not blocked yet', await simulateSubmit(bruteEmail, 'guess-1', bruteIp), 'wrong_password');
    check('wrong-password attempt 2 is refused on credentials, not blocked yet', await simulateSubmit(bruteEmail, 'guess-2', bruteIp), 'wrong_password');
    // attempt 1 was the signup itself, attempts 2-3 were the two guesses above — that's 3 of 3. The 4th (this one) trips the limiter.
    await checkThrowsRateLimited('a further guess after the attempt budget is spent is rate-limited before credentials are even checked',
      () => simulateSubmit(bruteEmail, 'guess-3', bruteIp));

    // ═══ repeated unknown-email requests from one source are capped too — the resource-exhaustion protection ═══
    const spamIp = `ip-spam-${Date.now()}`;
    for (let i = 0; i < 3; i++) {
      const r = await simulateSubmit(`spam-${Date.now()}-${i}@test.local`, 'x'.repeat(10), spamIp);
      check(`spam signup attempt ${i + 1} (fresh, never-seen email) succeeds`, r, 'created');
    }
    await checkThrowsRateLimited('a 4th signup attempt from the same IP is rate-limited even though every email is brand new (never seen before)',
      () => simulateSubmit(`spam-${Date.now()}-final@test.local`, 'x'.repeat(10), spamIp));

    console.log('\nall login rate-limit regression checks completed');
  } finally {
    if (createdUserIds.length) await db.user.deleteMany({ where: { id: { in: createdUserIds } } }).catch(() => {});
    if (createdWorkspaceIds.length) await db.workspace.deleteMany({ where: { id: { in: createdWorkspaceIds } } }).catch(() => {});
    if (usedIdentifiers.size) await db.loginAttempt.deleteMany({ where: { identifier: { in: [...usedIdentifiers] } } }).catch(() => {});
  }

  console.log(fails ? `\n${fails} FAILED` : '\nall login rate-limit regression tests passed');
  process.exit(fails ? 1 : 0);
}

main().finally(() => db.$disconnect());
