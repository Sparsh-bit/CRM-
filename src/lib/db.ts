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
 */
const g = globalThis as unknown as { prisma?: PrismaClient };

function build(): PrismaClient {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is not set');
  const client = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  if (process.env.NODE_ENV !== 'production') g.prisma = client;
  return client;
}

export const db = new Proxy({} as PrismaClient, {
  get(_target, prop, receiver) {
    const client = g.prisma ?? build();
    const value = Reflect.get(client as object, prop, receiver);
    return typeof value === 'function' ? value.bind(client) : value;
  },
});
