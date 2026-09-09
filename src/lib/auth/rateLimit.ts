/**
 * Abuse protection for src/app/login/page.tsx — the one endpoint in this app
 * with no session yet, so nothing else gates it. An unrecognized email
 * silently provisions a new user + workspace (that's the intentional
 * signup shortcut, not a bug), which makes this endpoint both a
 * password-brute-force target AND a resource-exhaustion target (each
 * attempt can create a real database row). This limits BOTH by counting
 * every attempt, not just failures, against two independent identifiers so
 * neither a single guessed account nor a single source can hammer it:
 *  - "email:<normalized email>" — caps attempts against one account/identity
 *    regardless of source.
 *  - "ip:<client ip>"           — caps attempts from one source regardless
 *    of how many different emails it cycles through.
 *
 * DB-backed (Postgres, already the app's own database) rather than an
 * in-memory Map: a Map is private to one process, and this app's own
 * queue.ts documents the worker as explicitly single-instance — the web
 * process serving login has no such guarantee, and an in-memory counter
 * would reset on every restart and multiply the real limit by however many
 * instances end up running. No new infrastructure (Upstash/Redis) needed
 * for this — a row-per-identifier table is enough at this volume.
 *
 * ponytail: fixed window, not a true sliding window — a burst can land two
 * windows' worth of attempts right at the boundary. Good enough to stop an
 * automated hammer; upgrade to a sliding-window/token-bucket table if this
 * ever needs to be precise under adversarial timing. The increment itself is
 * also read-then-write, not atomic — a burst of truly concurrent requests
 * for the same identifier could squeeze a couple of extra attempts past
 * MAX_ATTEMPTS before the count catches up. That only ever WEAKENS the cap
 * slightly under heavy concurrency, never bypasses it outright (a request
 * that reads a count already >= MAX_ATTEMPTS is refused every time), so it's
 * left as `updateMany`-free for now; switch the increment to the same
 * conditional-`updateMany` pattern approvals.ts uses if exact enforcement
 * under concurrent load ever matters more than simplicity here.
 */
import { db } from '../db';

const WINDOW_MS = Number(process.env.LOGIN_RATE_LIMIT_WINDOW_MS ?? 15 * 60_000);
const MAX_ATTEMPTS = Number(process.env.LOGIN_RATE_LIMIT_MAX_ATTEMPTS ?? 20);

export class RateLimitedError extends Error {}

/** Throws RateLimitedError if `identifier` has already used its budget for the current window; otherwise records this attempt and returns. Call once per identifier, BEFORE doing any of the work an attempt represents. */
export async function checkLoginRateLimit(identifier: string): Promise<void> {
  const now = new Date();
  const existing = await db.loginAttempt.findUnique({ where: { identifier } });

  if (!existing || now.getTime() - existing.windowStart.getTime() > WINDOW_MS) {
    // No row yet, or the previous window has expired — start a fresh one.
    await db.loginAttempt.upsert({
      where: { identifier },
      create: { identifier, count: 1, windowStart: now },
      update: { count: 1, windowStart: now },
    });
    return;
  }

  if (existing.count >= MAX_ATTEMPTS) {
    throw new RateLimitedError('Too many attempts. Try again in a few minutes.');
  }
  await db.loginAttempt.update({ where: { identifier }, data: { count: { increment: 1 } } });
}
