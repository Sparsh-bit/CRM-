/**
 * The one AI-analysis step in the research pipeline — reuses the existing
 * AI provider router (src/lib/ai/provider.ts), same as src/lib/ai/writer.ts
 * does for outreach drafts. No second model integration.
 */
import { z } from 'zod';
import { complete } from '../ai/provider';
import { parseJson } from '../ai/writer';
import { untrustedBlock, WEB_CONTENT_SYSTEM_PROMPT, REEL_ANALYSIS_SYSTEM_PROMPT, type WebContentAnalysis, type ReelAnalysis } from './prompts';

const webContentSchema = z.object({
  summary: z.string(),
  keyPoints: z.array(z.string()).max(8).default([]),
  businessSignals: z.array(z.string()).max(8).default([]),
  notableQuotes: z.array(z.string()).max(8).default([]),
});

const reelSchema = z.object({
  summary: z.string(),
  observed: z.object({
    hook: z.string().nullable().default(null),
    mainIdea: z.string().nullable().default(null),
    productOrService: z.string().nullable().default(null),
    callToAction: z.string().nullable().default(null),
    importantFeatures: z.array(z.string()).max(6).default([]),
  }),
  inferred: z.object({
    targetAudience: z.string().nullable().default(null),
    problemAddressed: z.string().nullable().default(null),
    businessModel: z.string().nullable().default(null),
    monetizationStrategy: z.string().nullable().default(null),
    workflow: z.string().nullable().default(null),
    positioning: z.string().nullable().default(null),
    marketingAngle: z.string().nullable().default(null),
    likelyCustomer: z.string().nullable().default(null),
  }),
  recommended: z.object({
    implementationIdeas: z.array(z.string()).max(6).default([]),
    differentiationOpportunities: z.array(z.string()).max(6).default([]),
    risks: z.array(z.string()).max(6).default([]),
    actionableTakeaways: z.array(z.string()).max(6).default([]),
  }),
  confidence: z.number().min(0).max(100),
});

export async function analyzeWebContent(text: string, sourceUrl: string, workspaceId: string): Promise<WebContentAnalysis> {
  const { text: raw } = await complete({
    system: WEB_CONTENT_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: `SOURCE URL: ${sourceUrl}\n\n${untrustedBlock('PAGE CONTENT', text)}` }],
    temperature: 0.3,
    maxTokens: 900,
    workspaceId,
  });
  const parsed = webContentSchema.safeParse(parseJson(raw));
  if (!parsed.success) throw new Error(`AI returned a malformed web-content analysis: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
  return parsed.data;
}

export async function analyzeReelContent(
  input: { transcript?: string | null; caption?: string | null; description?: string | null; durationSec?: number | null },
  workspaceId: string,
): Promise<ReelAnalysis> {
  const parts = [
    input.durationSec != null ? `DURATION: ${Math.round(input.durationSec)}s` : '',
    input.transcript ? untrustedBlock('AUDIO TRANSCRIPT', input.transcript) : '(no audio transcript available)',
    input.caption ? untrustedBlock('CAPTION', input.caption) : '',
    input.description ? untrustedBlock('PLATFORM DESCRIPTION', input.description) : '',
  ].filter(Boolean).join('\n\n');

  const { text: raw } = await complete({
    system: REEL_ANALYSIS_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: parts }],
    temperature: 0.4,
    maxTokens: 1400,
    workspaceId,
  });
  const parsed = reelSchema.safeParse(parseJson(raw));
  if (!parsed.success) throw new Error(`AI returned a malformed content analysis: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
  return parsed.data;
}
