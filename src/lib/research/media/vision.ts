/**
 * Optional frame/visual analysis (Section 4 & 15) — genuinely real when
 * configured, genuinely absent (never faked) when it isn't. The default
 * text models this app already uses (llama-3.3-70b-versatile, gpt-4.1-mini)
 * are not vision-capable, so guessing a model name would silently produce
 * garbage; this requires an explicit VISION_MODEL to be set alongside a
 * provider key, using the same OpenAI-compatible request shape
 * src/lib/ai/provider.ts already speaks for Groq/OpenAI (no second AI
 * integration — same credentials, same chat-completions endpoint, just with
 * image content parts appended).
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';

export type VisionResult =
  | { status: 'ok'; description: string; provider: string }
  | { status: 'unavailable'; reason: string };

const timeoutMs = () => Number(process.env.AI_TIMEOUT_MS ?? 30_000); // read at call time (see webFetch.ts)

function providerConfig(): { url: string; key: string; model: string; provider: string } | null {
  const model = process.env.VISION_MODEL;
  if (!model) return null;
  if (process.env.GROQ_API_KEY) return { url: 'https://api.groq.com/openai/v1/chat/completions', key: process.env.GROQ_API_KEY, model, provider: 'groq' };
  if (process.env.OPENAI_API_KEY) return { url: 'https://api.openai.com/v1/chat/completions', key: process.env.OPENAI_API_KEY, model, provider: 'openai' };
  return null;
}

async function frameToDataUrl(framePath: string): Promise<string> {
  const buf = await fs.readFile(framePath);
  return `data:image/jpeg;base64,${buf.toString('base64')}`;
}

/** Describes a small, bounded set of already-sampled frames in one call — never per-frame, never every frame in the source video. */
export async function analyzeFrames(framePaths: string[]): Promise<VisionResult> {
  const cfg = providerConfig();
  if (!cfg) {
    return { status: 'unavailable', reason: 'Capability unavailable with current configuration — set VISION_MODEL plus GROQ_API_KEY or OPENAI_API_KEY to enable frame analysis.' };
  }
  const images = await Promise.all(framePaths.map(frameToDataUrl));
  const content = [
    { type: 'text', text: `These are ${images.length} frames sampled evenly across a short video, in order (${framePaths.map((p) => path.basename(p)).join(', ')}). Describe what is visually shown across them in 3-5 sentences — on-screen text, setting, people, product/UI shown. Do not guess anything not visible.` },
    ...images.map((url) => ({ type: 'image_url', image_url: { url } })),
  ];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs());
  try {
    const res = await fetch(cfg.url, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.key}` },
      body: JSON.stringify({ model: cfg.model, max_tokens: 400, messages: [{ role: 'user', content }] }),
    });
    if (!res.ok) return { status: 'unavailable', reason: `Vision provider responded ${res.status}: ${(await res.text()).slice(0, 300)}` };
    const j = (await res.json()) as { choices: { message: { content: string } }[] };
    return { status: 'ok', description: j.choices[0]?.message?.content ?? '', provider: cfg.provider };
  } catch (e) {
    return { status: 'unavailable', reason: `Vision request failed: ${e instanceof Error ? e.message : String(e)}` };
  } finally {
    clearTimeout(timer);
  }
}
