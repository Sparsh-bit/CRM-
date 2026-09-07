/**
 * Research cache — avoids re-fetching an identical public page (Section 9).
 * Not workspace-scoped: a public page's extracted text is the same fact for
 * every workspace, and the model here explicitly excludes anything gated
 * behind a login wall (webFetch.ts only ever returns what an anonymous
 * request could see, so nothing private ever reaches this table).
 */
import { createHash } from 'node:crypto';
import { db } from '../db';
import type { Prisma } from '@/generated/prisma/client';
import type { Extraction } from './extract';

const ttlMs = () => Number(process.env.RESEARCH_CACHE_TTL_MS ?? 24 * 60 * 60 * 1000); // 24h default, read at call time (see webFetch.ts)

/** Strips fragment + trailing slash + lowercases the host, so the same page under trivial variants shares one cache row. */
export function normalizeUrl(rawUrl: string): string {
  const url = new URL(rawUrl);
  url.hash = '';
  url.hostname = url.hostname.toLowerCase();
  if (url.pathname !== '/' && url.pathname.endsWith('/')) url.pathname = url.pathname.slice(0, -1);
  return url.toString();
}

export function hashContent(body: string): string {
  return createHash('sha256').update(body).digest('hex');
}

export async function getCachedExtraction(rawUrl: string): Promise<Extraction | null> {
  const normalizedUrl = normalizeUrl(rawUrl);
  const row = await db.researchCache.findUnique({ where: { normalizedUrl } });
  if (!row || row.expiresAt < new Date()) return null;
  return row.extraction as unknown as Extraction;
}

export async function setCachedExtraction(rawUrl: string, rawBody: string, extraction: Extraction): Promise<void> {
  const normalizedUrl = normalizeUrl(rawUrl);
  const contentHash = hashContent(rawBody);
  const expiresAt = new Date(Date.now() + ttlMs());
  await db.researchCache.upsert({
    where: { normalizedUrl },
    create: { normalizedUrl, contentHash, extraction: extraction as unknown as Prisma.InputJsonValue, expiresAt },
    update: { contentHash, extraction: extraction as unknown as Prisma.InputJsonValue, expiresAt, fetchedAt: new Date() },
  });
}
