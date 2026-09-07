/**
 * Config validation (`src/lib/env.ts`) — the guard the server refuses to boot
 * without. Tests the pure `envProblems()` logic for every fatal/warn branch,
 * then `assertEnv()`'s throw-vs-warn-once behaviour, in that order, because
 * `assertEnv()` memoizes after its first non-fatal pass (see the comment on
 * `checked` in env.ts) and would otherwise poison later scenarios in this
 * same process.
 */
import { envProblems, assertEnv } from '../src/lib/env';

let fails = 0;
function check(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { fails++; console.log(`FAIL ${name}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`); }
  else console.log(`pass ${name}`);
}

function withEnv(vars: Record<string, string | undefined>, fn: () => void) {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) prev[k] = process.env[k];
  for (const [k, v] of Object.entries(vars)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { fn(); } finally {
    for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

const keysOf = (problems: ReturnType<typeof envProblems>) => problems.map((p) => p.key).sort();
const fatalKeysOf = (problems: ReturnType<typeof envProblems>) => problems.filter((p) => p.fatal).map((p) => p.key).sort();

const GOOD = { NODE_ENV: 'development', AUTH_SECRET: 'x'.repeat(40), DATABASE_URL: 'postgres://x', APP_URL: 'https://app.example.com', EVOLUTION_WEBHOOK_SECRET: 'x'.repeat(20), EVOLUTION_API_URL: 'https://evolution.example.com' };

withEnv(GOOD, () => check('fully configured -> no problems', envProblems(), []));

withEnv({ ...GOOD, AUTH_SECRET: undefined }, () =>
  check('missing AUTH_SECRET in dev -> warns, not fatal', fatalKeysOf(envProblems()).includes('AUTH_SECRET'), false));

withEnv({ ...GOOD, NODE_ENV: 'production', AUTH_SECRET: undefined }, () =>
  check('missing AUTH_SECRET in production -> fatal', fatalKeysOf(envProblems()).includes('AUTH_SECRET'), true));

withEnv({ ...GOOD, NODE_ENV: 'production', AUTH_SECRET: 'dev-only-insecure-secret-change-me' }, () =>
  check('published example secret in production -> fatal', fatalKeysOf(envProblems()).includes('AUTH_SECRET'), true));

withEnv({ ...GOOD, AUTH_SECRET: 'short' }, () =>
  check('short AUTH_SECRET -> warns, never fatal (already running, do not lock the owner out)', fatalKeysOf(envProblems()).includes('AUTH_SECRET'), false));

withEnv({ ...GOOD, DATABASE_URL: undefined }, () =>
  check('missing DATABASE_URL -> always fatal, even in dev', fatalKeysOf(envProblems()).includes('DATABASE_URL'), true));

withEnv({ ...GOOD, EVOLUTION_WEBHOOK_SECRET: undefined }, () =>
  check('missing EVOLUTION_WEBHOOK_SECRET -> warns (unauthenticated webhook risk), never fatal — not every workspace uses WhatsApp', fatalKeysOf(envProblems()).includes('EVOLUTION_WEBHOOK_SECRET'), false));
withEnv({ ...GOOD, NODE_ENV: 'production', EVOLUTION_WEBHOOK_SECRET: undefined }, () =>
  check('the warning fires even in production, not just dev', envProblems().some((p) => p.key === 'EVOLUTION_WEBHOOK_SECRET'), true));

withEnv({ ...GOOD, EVOLUTION_API_URL: undefined }, () =>
  check('missing EVOLUTION_API_URL -> warns (would silently target localhost in prod), never fatal', fatalKeysOf(envProblems()).includes('EVOLUTION_API_URL'), false));
withEnv({ ...GOOD, NODE_ENV: 'production', EVOLUTION_API_URL: undefined }, () =>
  check('the EVOLUTION_API_URL warning fires in production too', envProblems().some((p) => p.key === 'EVOLUTION_API_URL'), true));

withEnv({ ...GOOD, APP_URL: undefined }, () =>
  check('missing APP_URL in dev -> warns, not fatal', fatalKeysOf(envProblems()).includes('APP_URL'), false));

withEnv({ ...GOOD, NODE_ENV: 'production', APP_URL: undefined }, () =>
  check('missing APP_URL in production -> fatal', fatalKeysOf(envProblems()).includes('APP_URL'), true));

withEnv({ ...GOOD, NODE_ENV: 'production', APP_URL: 'http://localhost:3000' }, () =>
  check('localhost APP_URL in production -> fatal (dead unsubscribe links)', fatalKeysOf(envProblems()).includes('APP_URL'), true));

withEnv({ ...GOOD, NODE_ENV: 'production', APP_URL: 'http://app.example.com' }, () =>
  check('plain-http APP_URL in production -> warns, not fatal', fatalKeysOf(envProblems()).includes('APP_URL'), false));

withEnv({ NODE_ENV: 'development', AUTH_SECRET: undefined, DATABASE_URL: undefined, APP_URL: undefined }, () =>
  check('everything missing in dev -> only DATABASE_URL is fatal', fatalKeysOf(envProblems()), ['DATABASE_URL']));

// assertEnv(): throw-vs-warn, and the memoization the module documents.
// Order matters here — see the file comment.
withEnv({ NODE_ENV: 'production', AUTH_SECRET: undefined, DATABASE_URL: undefined, APP_URL: undefined }, () => {
  let threw = false;
  try { assertEnv(); } catch { threw = true; }
  check('assertEnv() throws on a fatal production config', threw, true);
});

withEnv(GOOD, () => {
  let threw = false;
  try { assertEnv(); } catch { threw = true; }
  check('assertEnv() does not throw once configured correctly', threw, false);
});

withEnv({ NODE_ENV: 'production', AUTH_SECRET: undefined, DATABASE_URL: undefined, APP_URL: undefined }, () => {
  // Same fatal config as the first throw — but assertEnv() already succeeded
  // once above, so it is memoized and must not re-check (and must not throw).
  let threw = false;
  try { assertEnv(); } catch { threw = true; }
  check('assertEnv() memoizes after its first clean pass — does not re-throw', threw, false);
});

console.log(fails ? `\n${fails} FAILED` : '\nall env tests passed');
process.exit(fails ? 1 : 0);
