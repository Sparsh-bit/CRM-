/**
 * Phase 9 — real web/social research tools. Every fetch goes through
 * WebFetchService (SSRF-guarded, size/time-bounded); every AI step reuses
 * the existing provider router (src/lib/ai/provider.ts) with fetched/
 * uploaded content framed as untrusted data (src/lib/research/prompts.ts) —
 * never as instructions. No fake scraping, no fabricated Instagram content:
 * every failure mode returns a structured, honest result instead of
 * guessing (see src/lib/research/instagram.ts and webFetch.ts).
 *
 * Two permission groups, matching the least-privilege split Section 12 asks
 * for: `research:web` (search/fetch/analyze a public page) and
 * `research:social` (Instagram + uploaded media — a materially different,
 * higher-effort capability a plain Research agent doesn't need).
 */
import { z } from 'zod';
import { db } from '../../db';
import { registerTool } from '../registry';
import { enqueue } from '../../queue';
import { resultSchema, toolResult } from './shared';
import { webSearch } from '../../research/search';
import { fetchPage } from '../../research/webFetch';
import { extractReadableContent, type Extraction } from '../../research/extract';
import { getCachedExtraction, setCachedExtraction } from '../../research/cache';
import { analyzeInstagramUrl, isInstagramUrl } from '../../research/instagram';
import { analyzeWebContent, analyzeReelContent } from '../../research/analyze';
import { saveToKnowledge, searchKnowledge } from '../../research/knowledge';
import { checkQuota, recordUsage, QuotaExceededError } from '../../usage/service';
import type { Prisma } from '@/generated/prisma/client';

// ── web_search ───────────────────────────────────────────────────────────
registerTool({
  name: 'web_search',
  description: 'Search the web through the configured SearchService (SearXNG or an approved API provider). Returns real results, or an honest not_configured/error status — never fabricated results.',
  inputSchema: z.object({ query: z.string().min(1).max(300), limit: z.number().int().min(1).max(20).optional() }),
  outputSchema: resultSchema(z.object({
    status: z.enum(['ok', 'not_configured', 'error']),
    provider: z.string().optional(),
    results: z.array(z.object({ title: z.string(), url: z.string(), snippet: z.string() })),
    reason: z.string().optional(),
  })),
  requiredPermission: 'research:web',
  category: 'research',
  readOnly: true,
  idempotent: true,
  handler: async (input) => {
    const res = await webSearch(input.query, input.limit ?? 8);
    if (res.status === 'ok') return toolResult({ status: res.status, provider: res.provider, results: res.results }, res.results.length, `${res.results.length} result(s) for "${input.query}".`);
    return toolResult({ status: res.status, results: [], reason: res.reason }, 0, res.reason);
  },
});

// ── fetch_web_page ───────────────────────────────────────────────────────
const pageExtractionSchema = z.object({
  status: z.enum(['ok', 'unavailable']),
  finalUrl: z.string().optional(),
  title: z.string().optional(),
  excerpt: z.string().optional(),
  textContent: z.string().optional(),
  truncated: z.boolean().optional(),
  cached: z.boolean().optional(),
  reason: z.string().optional(),
});

async function fetchAndExtract(url: string): Promise<
  | { ok: true; finalUrl: string; extraction: Extraction; cached: boolean }
  | { ok: false; reason: string }
> {
  const cached = await getCachedExtraction(url);
  if (cached) return { ok: true, finalUrl: url, extraction: cached, cached: true };

  const fetched = await fetchPage(url);
  if (!fetched.ok) return { ok: false, reason: fetched.reason };
  const extracted = extractReadableContent(fetched.body, fetched.finalUrl);
  if (!extracted.ok) return { ok: false, reason: extracted.reason };
  await setCachedExtraction(fetched.finalUrl, fetched.body, extracted.extraction);
  return { ok: true, finalUrl: fetched.finalUrl, extraction: extracted.extraction, cached: false };
}

registerTool({
  name: 'fetch_web_page',
  description: 'Fetch one public web page (SSRF-guarded, size/time-bounded) and return its clean, readable text via Readability — no AI call, just real extraction. Cached for 24h by default so the same public page is not re-fetched repeatedly.',
  inputSchema: z.object({ url: z.string().url() }),
  outputSchema: resultSchema(pageExtractionSchema),
  requiredPermission: 'research:web',
  category: 'research',
  readOnly: true,
  idempotent: true,
  handler: async (input) => {
    const result = await fetchAndExtract(input.url);
    if (!result.ok) return toolResult({ status: 'unavailable' as const, reason: result.reason }, 0, result.reason);
    const e = result.extraction;
    return toolResult(
      { status: 'ok' as const, finalUrl: result.finalUrl, title: e.title, excerpt: e.excerpt, textContent: e.textContent, truncated: e.truncated, cached: result.cached },
      1,
      `Extracted "${e.title || result.finalUrl}" (${e.length} chars${result.cached ? ', from cache' : ''}).`,
    );
  },
});

// ── analyze_web_content ──────────────────────────────────────────────────
registerTool({
  name: 'analyze_web_content',
  description: 'Fetch a public web page and run real AI analysis over its extracted text (summary, key points, business signals, notable quotes). The page content is treated as untrusted data, never as instructions. Returns an honest unavailable result if the page cannot be fetched or has no readable article content.',
  inputSchema: z.object({ url: z.string().url() }),
  outputSchema: resultSchema(z.object({
    status: z.enum(['ok', 'unavailable']),
    analysisId: z.string().optional(),
    finalUrl: z.string().optional(),
    title: z.string().optional(),
    analysis: z.object({ summary: z.string(), keyPoints: z.array(z.string()), businessSignals: z.array(z.string()), notableQuotes: z.array(z.string()) }).optional(),
    reason: z.string().optional(),
  })),
  requiredPermission: 'research:web',
  category: 'research',
  readOnly: false, // calls a real AI provider, same convention as prepare_email/etc.
  // Not keyed/deduped like proposeOutreach — a retry creates a SECOND
  // MediaAnalysis row, not a no-op. Same lesson src/lib/agents/outreach.ts's
  // propose_send already learned the hard way (docs/agent-outreach.md):
  // idempotent:true here would let a permanent failure (a page that will
  // never fetch, a URL that's not an Instagram post) get silently requeued
  // for retry instead of reported as Failed.
  idempotent: false,
  handler: async (input, ctx) => {
    try {
      await checkQuota(ctx.workspaceId, 'research_task');
    } catch (e) {
      if (e instanceof QuotaExceededError) return toolResult({ status: 'unavailable' as const, reason: e.message }, 0, e.message);
      throw e;
    }
    const analysisRow = await db.mediaAnalysis.create({
      data: { workspaceId: ctx.workspaceId, agentId: ctx.agentId, taskId: ctx.taskId, sourceUrl: input.url, sourceType: 'web_url', status: 'processing' },
    });
    await recordUsage(ctx.workspaceId, 'research_task', 1, { url: input.url });
    const fetched = await fetchAndExtract(input.url);
    if (!fetched.ok) {
      await db.mediaAnalysis.update({ where: { id: analysisRow.id }, data: { status: 'failed', error: fetched.reason.slice(0, 2000) } });
      return toolResult({ status: 'unavailable' as const, analysisId: analysisRow.id, reason: fetched.reason }, 0, fetched.reason);
    }
    const analysis = await analyzeWebContent(fetched.extraction.textContent, fetched.finalUrl, ctx.workspaceId);
    await db.mediaAnalysis.update({ where: { id: analysisRow.id }, data: { status: 'completed', result: analysis as unknown as Prisma.InputJsonValue } });
    return toolResult(
      { status: 'ok' as const, analysisId: analysisRow.id, finalUrl: fetched.finalUrl, title: fetched.extraction.title, analysis },
      1,
      analysis.summary,
    );
  },
});

// ── analyze_social_content ───────────────────────────────────────────────
const reelAnalysisOutputSchema = z.object({
  summary: z.string(),
  observed: z.object({ hook: z.string().nullable(), mainIdea: z.string().nullable(), productOrService: z.string().nullable(), callToAction: z.string().nullable(), importantFeatures: z.array(z.string()) }),
  inferred: z.object({ targetAudience: z.string().nullable(), problemAddressed: z.string().nullable(), businessModel: z.string().nullable(), monetizationStrategy: z.string().nullable(), workflow: z.string().nullable(), positioning: z.string().nullable(), marketingAngle: z.string().nullable(), likelyCustomer: z.string().nullable() }),
  recommended: z.object({ implementationIdeas: z.array(z.string()), differentiationOpportunities: z.array(z.string()), risks: z.array(z.string()), actionableTakeaways: z.array(z.string()) }),
  confidence: z.number(),
});

registerTool({
  name: 'analyze_social_content',
  description: 'Analyze a public social post URL. Only instagram.com is supported (Section 16: no login bypass, no anti-bot evasion) — reads only the Open Graph metadata an anonymous request can see (title/caption/thumbnail). Never fetches or fabricates a video. Returns a structured unavailable result with suggestions (including "upload the file instead") for a private/inaccessible/unsupported post.',
  inputSchema: z.object({ url: z.string().url() }),
  outputSchema: resultSchema(z.object({
    status: z.enum(['ok', 'unavailable']),
    analysisId: z.string().optional(),
    analysis: reelAnalysisOutputSchema.optional(),
    reason: z.string().optional(),
    suggestions: z.array(z.string()).optional(),
  })),
  requiredPermission: 'research:social',
  category: 'research',
  readOnly: false,
  idempotent: false, // same reasoning as analyze_web_content above — not keyed/deduped
  handler: async (input, ctx) => {
    try {
      await checkQuota(ctx.workspaceId, 'research_task');
    } catch (e) {
      if (e instanceof QuotaExceededError) return toolResult({ status: 'unavailable' as const, reason: e.message }, 0, e.message);
      throw e;
    }
    const analysisRow = await db.mediaAnalysis.create({
      data: { workspaceId: ctx.workspaceId, agentId: ctx.agentId, taskId: ctx.taskId, sourceUrl: input.url, sourceType: 'social_url', status: 'processing' },
    });
    await recordUsage(ctx.workspaceId, 'research_task', 1, { url: input.url });

    if (!isInstagramUrl(input.url)) {
      const reason = `"${input.url}" is not a supported social platform — only instagram.com is supported in this build.`;
      await db.mediaAnalysis.update({ where: { id: analysisRow.id }, data: { status: 'failed', error: reason } });
      return toolResult({ status: 'unavailable' as const, analysisId: analysisRow.id, reason, suggestions: ['Upload the file directly with analyze_uploaded_media instead.'] }, 0, reason);
    }

    const ig = await analyzeInstagramUrl(input.url);
    if (ig.status === 'unavailable') {
      await db.mediaAnalysis.update({ where: { id: analysisRow.id }, data: { status: 'failed', error: ig.reason } });
      return toolResult({ status: 'unavailable' as const, analysisId: analysisRow.id, reason: ig.reason, suggestions: ig.suggestions }, 0, ig.reason);
    }

    const analysis = await analyzeReelContent({ caption: ig.data.description, description: ig.data.title }, ctx.workspaceId);
    await db.mediaAnalysis.update({ where: { id: analysisRow.id }, data: { status: 'completed', result: { source: ig.data, analysis } as unknown as Prisma.InputJsonValue } });
    return toolResult({ status: 'ok' as const, analysisId: analysisRow.id, analysis }, 1, analysis.summary);
  },
});

// ── analyze_uploaded_media ───────────────────────────────────────────────
registerTool({
  name: 'analyze_uploaded_media',
  description: 'Queue a real analysis pipeline (metadata, audio extraction, transcription, optional frame analysis, structured content analysis) for an already-uploaded MediaAsset. Runs asynchronously through the existing Job queue/worker (large files are never processed inline) — returns immediately with a mediaAnalysisId; poll get_media_analysis for the result.',
  inputSchema: z.object({ mediaId: z.string().min(1) }),
  outputSchema: resultSchema(z.object({ mediaAnalysisId: z.string(), status: z.literal('queued') })),
  requiredPermission: 'research:social',
  category: 'research',
  readOnly: false,
  // A cross-workspace/missing mediaId is a permanent failure (the asset will
  // never become visible to this workspace on a retry) — idempotent:true
  // would let the runtime silently requeue that as if it might succeed next
  // time. Same lesson as analyze_web_content above.
  idempotent: false,
  handler: async (input, ctx) => {
    const asset = await db.mediaAsset.findFirst({ where: { id: input.mediaId, workspaceId: ctx.workspaceId } });
    if (!asset) throw new Error('MediaAsset not found in this workspace.');
    await checkQuota(ctx.workspaceId, 'media_analysis'); // real worker time (ffmpeg) is about to be spent — checked before enqueueing, not after

    const analysisRow = await db.mediaAnalysis.create({
      data: { workspaceId: ctx.workspaceId, agentId: ctx.agentId, taskId: ctx.taskId, mediaAssetId: asset.id, sourceType: 'upload', status: 'queued' },
    });
    await recordUsage(ctx.workspaceId, 'media_analysis', 1, { mediaId: asset.id });
    await enqueue(ctx.workspaceId, 'process_media', { mediaAnalysisId: analysisRow.id });
    return toolResult({ mediaAnalysisId: analysisRow.id, status: 'queued' as const }, 1, `Queued media analysis for "${asset.filename}".`);
  },
});

// ── get_media_analysis ───────────────────────────────────────────────────
registerTool({
  name: 'get_media_analysis',
  description: 'Check the status/result of a previous analyze_web_content, analyze_social_content, or analyze_uploaded_media call by its analysisId.',
  inputSchema: z.object({ mediaAnalysisId: z.string().min(1) }),
  outputSchema: resultSchema(z.object({ status: z.string(), sourceType: z.string(), result: z.unknown().nullable(), error: z.string().nullable() }).nullable()),
  requiredPermission: 'research:web',
  category: 'research',
  readOnly: true,
  idempotent: true,
  handler: async (input, ctx) => {
    const row = await db.mediaAnalysis.findFirst({ where: { id: input.mediaAnalysisId, workspaceId: ctx.workspaceId } });
    if (!row) return toolResult(null, 0, 'No media analysis found with that id in this workspace.');
    return toolResult({ status: row.status, sourceType: row.sourceType, result: row.result, error: row.error }, 1, `Analysis is ${row.status}.`);
  },
});

// ── save_to_knowledge / search_knowledge ─────────────────────────────────
registerTool({
  name: 'save_to_knowledge',
  description: 'Explicitly store research findings as searchable text chunks (Section 10 — never automatic; only called when a task explicitly decides a result is worth keeping).',
  inputSchema: z.object({
    sourceUrl: z.string().url().optional(),
    sourceType: z.enum(['web', 'social', 'media', 'manual']),
    content: z.string().min(1).max(50_000),
  }),
  outputSchema: resultSchema(z.object({ chunksStored: z.number() })),
  requiredPermission: 'research:knowledge',
  category: 'research',
  readOnly: false,
  idempotent: false, // a retry would duplicate chunks — not safe to auto-retry
  handler: async (input, ctx) => {
    const saved = await saveToKnowledge(ctx.workspaceId, { sourceUrl: input.sourceUrl ?? null, sourceType: input.sourceType, content: input.content });
    return toolResult(saved, saved.chunksStored, `Stored ${saved.chunksStored} chunk(s) in the workspace knowledge base.`);
  },
});

registerTool({
  name: 'search_knowledge',
  description: 'Keyword (full-text) search over previously saved knowledge chunks in this workspace. No embeddings/semantic search yet — see docs/research.md.',
  inputSchema: z.object({ query: z.string().min(1).max(300), limit: z.number().int().min(1).max(50).optional() }),
  outputSchema: resultSchema(z.array(z.object({ id: z.string(), sourceUrl: z.string().nullable(), sourceType: z.string(), chunkIndex: z.number(), content: z.string() }))),
  requiredPermission: 'research:knowledge',
  category: 'research',
  readOnly: true,
  idempotent: true,
  handler: async (input, ctx) => {
    const rows = await searchKnowledge(ctx.workspaceId, input.query, input.limit ?? 10);
    const data = rows.map((r) => ({ id: r.id, sourceUrl: r.sourceUrl, sourceType: r.sourceType, chunkIndex: r.chunkIndex, content: r.content }));
    return toolResult(data, data.length, `${data.length} matching chunk(s) for "${input.query}".`);
  },
});
