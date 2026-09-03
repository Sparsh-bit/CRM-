import 'dotenv/config';
import path from 'node:path';
import { defineConfig, env } from 'prisma/config';

/**
 * Prisma 7 keeps the connection URL out of schema.prisma. The CLI (migrate,
 * db push, studio) reads it from here; the runtime client builds its own
 * connection through the node-postgres driver adapter in src/lib/db.ts.
 */
export default defineConfig({
  schema: path.join('prisma', 'schema.prisma'),
  migrations: { path: path.join('prisma', 'migrations') },
  datasource: { url: env('DATABASE_URL') },
});
