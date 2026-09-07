import { PrismaClient } from '@/generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

/**
 * Prisma 7 is Rust-free: the client reaches Postgres through a driver adapter
 * (node-postgres) instead of a downloaded query engine. Fewer moving parts,
 * smaller deploys, and it installs on networks that block binaries.prisma.sh.
 *
 * The client is built lazily behind a Proxy. `next build` imports every module
 * to collect page data, and a client constructed at import time would demand
 * DATABASE_URL during the build — which is not where a database belongs.
 *
 * FIXED (Phase 11 production hardening): the cache-to-`globalThis` line used
 * to be skipped in production (`if (NODE_ENV !== 'production')`), which is
 * backwards from the classic "cache always, guard only against Next dev's
 * module hot-reload duplicating the client" pattern this was modeled on. In
 * the classic pattern the client is built once at module top-level regardless
 * of the global-cache guard, so that guard is inert in production. HERE the
 * client is built lazily inside this Proxy's `get` trap instead — so
 * skipping the cache in production meant `build()` (a brand-new
 * PrismaClient + a brand-new pg.Pool, i.e. a brand-new real Postgres
 * connection) ran on EVERY `db.<model>` property access, not once per
 * process. Measured directly against real Postgres before this fix: 6
 * ordinary `db.X` calls in one script, run with NODE_ENV=production, opened
 * 6 new connections. A real deployment would exhaust Supabase's connection
 * limit within moments. Always caching (regardless of NODE_ENV) is the
 * correct fix — the Proxy's laziness alone (deferring the FIRST build()
 * call until an actual property access) is what avoids demanding
 * DATABASE_URL during `next build`; caching the result doesn't undo that.
 */
const g = globalThis as unknown as { prisma?: PrismaClient };

function build(): PrismaClient {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is not set');
  const client = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  g.prisma = client;
  return client;
}

export const db = new Proxy({} as PrismaClient, {
  get(_target, prop, receiver) {
    const client = g.prisma ?? build();
    const value = Reflect.get(client as object, prop, receiver);
    return typeof value === 'function' ? value.bind(client) : value;
  },
});
