/**
 * Explicit-only research memory (Section 10). A research result is never
 * automatically written here — only save_to_knowledge (an agent tool the
 * agent's own task must explicitly call, or a human action later) puts
 * something in. Retrieval is plain Postgres full-text search over the
 * stored chunks; there is no embedding/vector index in this build (no
 * pgvector extension is assumed present, and adding one is a real
 * infrastructure decision, not a Phase 9 detail) — see docs/research.md
 * "Known limitations" for the upgrade path once an embedding-capable
 * provider and pgvector are both available.
 */
import { db } from '../db';

const CHUNK_SIZE = 1000;

/** Splits on paragraph boundaries where possible, falling back to a hard cut only when a single paragraph exceeds CHUNK_SIZE. */
export function chunkText(text: string): string[] {
  const paragraphs = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const chunks: string[] = [];
  let current = '';
  for (const p of paragraphs) {
    if ((current + '\n\n' + p).length > CHUNK_SIZE && current) {
      chunks.push(current);
      current = '';
    }
    if (p.length > CHUNK_SIZE) {
      if (current) { chunks.push(current); current = ''; }
      for (let i = 0; i < p.length; i += CHUNK_SIZE) chunks.push(p.slice(i, i + CHUNK_SIZE));
      continue;
    }
    current = current ? `${current}\n\n${p}` : p;
  }
  if (current) chunks.push(current);
  return chunks;
}

export async function saveToKnowledge(
  workspaceId: string,
  input: { sourceUrl?: string | null; sourceType: 'web' | 'social' | 'media' | 'manual'; content: string },
): Promise<{ chunksStored: number }> {
  const chunks = chunkText(input.content);
  await db.$transaction(
    chunks.map((content, chunkIndex) =>
      db.knowledgeChunk.create({
        data: { workspaceId, sourceUrl: input.sourceUrl ?? null, sourceType: input.sourceType, chunkIndex, content },
      }),
    ),
  );
  return { chunksStored: chunks.length };
}

export async function searchKnowledge(workspaceId: string, query: string, limit = 10) {
  // Prisma has no native full-text-search filter for a plain String column
  // (no @db.Text tsvector), so this uses a raw query against
  // to_tsvector/plainto_tsquery — still fully parameterized, no string
  // interpolation of the query itself.
  return db.$queryRaw<{ id: string; sourceUrl: string | null; sourceType: string; chunkIndex: number; content: string; rank: number }[]>`
    SELECT id, "sourceUrl", "sourceType", "chunkIndex", content,
           ts_rank(to_tsvector('english', content), plainto_tsquery('english', ${query})) AS rank
    FROM "KnowledgeChunk"
    WHERE "workspaceId" = ${workspaceId}
      AND to_tsvector('english', content) @@ plainto_tsquery('english', ${query})
    ORDER BY rank DESC
    LIMIT ${limit}
  `;
}
