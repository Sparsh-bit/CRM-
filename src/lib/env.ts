/**
 * Environment validation, checked once at first use.
 *
 * Two settings are dangerous when missing rather than merely inconvenient, and
 * both used to fall back silently:
 *
 *  - **AUTH_SECRET** signs session cookies AND derives the key that encrypts
 *    every SMTP password, API key and OAuth token. It fell back to
 *    'dev-only-insecure-secret-change-me' — a string published in this
 *    repository. A production deploy that forgot to set it would let anyone
 *    who has read the source forge a session for any workspace and decrypt
 *    every stored credential.
 *
 *  - **APP_URL** is the base of every tracking pixel, click link and
 *    unsubscribe link. It fell back to http://localhost:3000, so a production
 *    send would put a dead unsubscribe link in front of every recipient —
 *    which is both a compliance failure and a fast route to spam complaints.
 *
 * In production these are fatal. In development they warn once and carry on,
 * because failing a local `npm run dev` over a missing secret helps nobody.
 */

const DEV_SECRET = 'dev-only-insecure-secret-change-me';

/**
 * Read at call time, not at module load.
 *
 * A module-level constant is captured before `dotenv` has necessarily run, and
 * it makes the whole module untestable — you cannot check that a localhost
 * APP_URL is fatal in production without spawning a second process.
 */
const isProduction = () => process.env.NODE_ENV === 'production';

let checked = false;
const warned = new Set<string>();

function warnOnce(key: string, message: string) {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`\n⚠  ${message}\n`);
}

export type EnvProblem = { key: string; message: string; fatal: boolean };

/** Everything wrong with the current environment. Used by the check below and by the UI. */
export function envProblems(): EnvProblem[] {
  const problems: EnvProblem[] = [];
  const secret = process.env.AUTH_SECRET;

  if (!secret || secret === DEV_SECRET) {
    problems.push({
      key: 'AUTH_SECRET',
      fatal: isProduction(),
      message: secret === DEV_SECRET
        ? 'AUTH_SECRET is still the example value from .env.example. It signs sessions and encrypts every stored password — change it to 32+ random characters.'
        : 'AUTH_SECRET is not set. It signs sessions and encrypts every stored password. Set it to 32+ random characters, and back it up: changing it later logs everyone out and makes stored credentials undecryptable.',
    });
  } else if (secret.length < 32) {
    problems.push({
      key: 'AUTH_SECRET',
      fatal: false,
      message: `AUTH_SECRET is only ${secret.length} characters. Use at least 32.`,
    });
  }

  if (!process.env.DATABASE_URL) {
    problems.push({ key: 'DATABASE_URL', fatal: true, message: 'DATABASE_URL is not set. Nothing can load or save.' });
  }

  const appUrl = process.env.APP_URL;
  if (!appUrl) {
    problems.push({
      key: 'APP_URL',
      fatal: isProduction(),
      message: 'APP_URL is not set, so tracking pixels, click links and unsubscribe links would point at localhost. Recipients would get a dead unsubscribe link.',
    });
  } else if (isProduction() && /localhost|127\.0\.0\.1/.test(appUrl)) {
    problems.push({
      key: 'APP_URL',
      fatal: true,
      message: `APP_URL is "${appUrl}" in a production build. Every unsubscribe link sent to a recipient would be dead.`,
    });
  } else if (isProduction() && !appUrl.startsWith('https://')) {
    problems.push({
      key: 'APP_URL',
      fatal: false,
      message: `APP_URL is "${appUrl}". Use https in production — some mail clients refuse to open a plain-http unsubscribe link.`,
    });
  }

  // Not made fatal even in production: a workspace with no WhatsApp
  // instance connected has no real exposure from this, and this check has
  // no way to know per-deployment whether WhatsApp is actually in use — but
  // for anyone who IS using it, an unset secret means
  // src/app/api/webhooks/evolution/route.ts accepts an unauthenticated
  // POST from anyone who finds the URL (a fake connection-state update, or
  // a fake "replied" that silently stops a real campaign sequence for a
  // lead who never actually replied) — real enough to warn about loudly,
  // every time, not just note in a doc.
  if (!process.env.EVOLUTION_WEBHOOK_SECRET) {
    problems.push({
      key: 'EVOLUTION_WEBHOOK_SECRET',
      fatal: false,
      message: 'EVOLUTION_WEBHOOK_SECRET is not set — if WhatsApp is connected, /api/webhooks/evolution accepts an unauthenticated POST from anyone who finds the URL (a fake connection-state update, or a fake "replied" that silently stops a real send sequence). Set it if you use WhatsApp.',
    });
  }

  // Found by a peer session's audit: EVOLUTION_API_URL falls back to
  // localhost with no production guard (unlike APP_URL, which already has
  // one) — every WhatsApp send/connect call would silently target
  // localhost in production if this were ever left unset.
  if (!process.env.EVOLUTION_API_URL) {
    problems.push({
      key: 'EVOLUTION_API_URL',
      fatal: false,
      message: 'EVOLUTION_API_URL is not set — src/lib/whatsapp/evolution.ts falls back to http://localhost:8080, so every WhatsApp send/connect call would silently target localhost. Set it if you use WhatsApp.',
    });
  }

  return problems;
}

/**
 * Called by anything that depends on a secret. Throws in production, warns in
 * development, and does the work only once.
 */
export function assertEnv(): void {
  if (checked) return;

  const problems = envProblems();
  const fatal = problems.filter((p) => p.fatal);

  if (fatal.length) {
    // Note the ordering: `checked` is NOT set before this throw. An earlier
    // version set it first, so the very first request failed and every request
    // after it sailed through — a fail-fast that fails exactly once is worse
    // than none, because it looks like a transient blip.
    const lines = fatal.map((p) => `  • ${p.key}: ${p.message}`).join('\n');
    throw new Error(`Refusing to run with an unsafe configuration:\n${lines}\n`);
  }

  checked = true;
  for (const p of problems) warnOnce(p.key, `${p.key}: ${p.message}`);
}

/** The one place that reads AUTH_SECRET. */
export function authSecret(): string {
  assertEnv();
  return process.env.AUTH_SECRET || DEV_SECRET;
}

/** The one place that reads APP_URL. Never a trailing slash. */
export function appUrl(): string {
  assertEnv();
  return (process.env.APP_URL || 'http://localhost:3000').replace(/\/+$/, '');
}
