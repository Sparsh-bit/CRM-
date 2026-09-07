import { db } from '../db';

export type ChatMessage = { role: 'user' | 'assistant'; content: string };

export type CompleteArgs = {
  system: string;
  messages: ChatMessage[];
  maxTokens?: number;
  temperature?: number;
  model?: string;
  /** When set, one UsageEvent row is written per successful call. */
  workspaceId?: string;
};

export type CompleteResult = { text: string; model: string; provider: string };

// Read at call time, not module load, so a test can vary them per scenario
// and a long-running process picks up a changed env without a restart.
const timeoutMs = () => Number(process.env.AI_TIMEOUT_MS ?? 30_000);
const maxRetries = () => Number(process.env.AI_RETRIES ?? 2);

/** A provider call that failed. `retryable` says whether trying again (same provider) can help. */
class ProviderError extends Error {
  constructor(message: string, public retryable: boolean) { super(message); }
}

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

/** Exponential backoff with jitter, only across retryable failures. */
async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  const retries = maxRetries();
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const retryable = e instanceof ProviderError ? e.retryable : true; // network/timeout: worth another try
      if (!retryable || attempt === retries) throw e;
      await sleep(2 ** attempt * 500 + Math.random() * 250);
    }
  }
  throw lastErr;
}

async function withTimeout<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ms = timeoutMs();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fn(controller.signal);
  } catch (e) {
    if (controller.signal.aborted) throw new ProviderError(`Timed out after ${ms}ms`, true);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/** 429 and 5xx are worth retrying or falling back on; a 4xx like a bad key or a bad request is not. */
function classify(status: number, body: string): never {
  const retryable = status === 429 || status >= 500;
  throw new ProviderError(`${status}: ${body.slice(0, 400)}`, retryable);
}

/**
 * Which providers to try, in order. `AI_PROVIDER` (legacy, singular) still
 * pins to exactly one provider with no fallback — unchanged behaviour for
 * anyone who already sets it. Unset, the default is the full chain, filtered
 * down to whichever providers actually have a key configured (no point
 * burning a retry cycle on one we know has no credentials) — unless that
 * filter would empty the list, in which case the first entry fails with its
 * own "key is not set" error, exactly as a single unconfigured provider did
 * before this router existed.
 */
function providerChain(): string[] {
  const raw = process.env.AI_PROVIDER_CHAIN || process.env.AI_PROVIDER || 'groq,anthropic,openai';
  const requested = raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const configured = requested.filter(hasCredentials);
  return configured.length ? configured : requested;
}

function hasCredentials(provider: string): boolean {
  if (provider === 'groq') return !!process.env.GROQ_API_KEY;
  if (provider === 'anthropic') return !!process.env.ANTHROPIC_API_KEY;
  if (provider === 'openai') return !!process.env.OPENAI_API_KEY;
  return false;
}

type Usage = { inputTokens?: number; outputTokens?: number };
type ProviderResult = { text: string; model: string; usage?: Usage };

async function callProvider(provider: string, a: CompleteArgs): Promise<ProviderResult> {
  if (provider === 'groq') return openAiCompatible(a, {
    url: 'https://api.groq.com/openai/v1/chat/completions',
    key: process.env.GROQ_API_KEY, keyName: 'GROQ_API_KEY',
    defaultModel: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
  });
  if (provider === 'openai') return openAiCompatible(a, {
    url: 'https://api.openai.com/v1/chat/completions',
    key: process.env.OPENAI_API_KEY, keyName: 'OPENAI_API_KEY',
    defaultModel: process.env.OPENAI_MODEL || 'gpt-4.1-mini',
  });
  if (provider === 'anthropic') return anthropic(a);
  throw new ProviderError(`Unknown AI provider: ${provider}`, false);
}

async function anthropic(a: CompleteArgs): Promise<ProviderResult> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new ProviderError('ANTHROPIC_API_KEY is not set', false);
  const model = a.model || process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5';
  return withTimeout(async (signal) => {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: a.maxTokens ?? 1200,
        temperature: a.temperature ?? 0.7,
        system: a.system,
        messages: a.messages,
      }),
    });
    if (!res.ok) classify(res.status, await res.text());
    const j = (await res.json()) as {
      content: { type: string; text?: string }[];
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    return {
      text: j.content.filter((c) => c.type === 'text').map((c) => c.text ?? '').join(''),
      model,
      usage: j.usage && { inputTokens: j.usage.input_tokens, outputTokens: j.usage.output_tokens },
    };
  });
}

/** OpenAI and Groq both speak the OpenAI chat-completions shape — one client for both. */
async function openAiCompatible(
  a: CompleteArgs,
  cfg: { url: string; key: string | undefined; keyName: string; defaultModel: string },
): Promise<ProviderResult> {
  if (!cfg.key) throw new ProviderError(`${cfg.keyName} is not set`, false);
  const model = a.model || cfg.defaultModel;
  return withTimeout(async (signal) => {
    const res = await fetch(cfg.url, {
      method: 'POST',
      signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.key}` },
      body: JSON.stringify({
        model,
        max_tokens: a.maxTokens ?? 1200,
        temperature: a.temperature ?? 0.7,
        messages: [{ role: 'system', content: a.system }, ...a.messages],
      }),
    });
    if (!res.ok) classify(res.status, await res.text());
    const j = (await res.json()) as {
      choices: { message: { content: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    return {
      text: j.choices[0]?.message?.content ?? '',
      model,
      usage: j.usage && { inputTokens: j.usage.prompt_tokens, outputTokens: j.usage.completion_tokens },
    };
  });
}

async function recordUsage(workspaceId: string, provider: string, r: ProviderResult) {
  try {
    await db.usageEvent.create({
      data: {
        workspaceId,
        kind: 'ai_request',
        meta: { provider, model: r.model, ...(r.usage ?? {}) },
      },
    });
  } catch (e) {
    // Usage accounting must never take down a real send/draft over a logging failure.
    console.error('[usage]', e instanceof Error ? e.message : e);
  }
}

/**
 * Provider-agnostic completion with fallback. Tries each provider in the
 * chain in order, retrying transient failures (timeout, 429, 5xx) with
 * backoff before moving on; a bad key or bad request skips straight to the
 * next provider. Never rotates keys within a provider to dodge a rate limit —
 * only ever the next distinct, already-configured provider.
 */
export async function complete(args: CompleteArgs): Promise<CompleteResult> {
  const chain = providerChain();
  const errors: string[] = [];

  for (const provider of chain) {
    try {
      const result = await withRetry(() => callProvider(provider, args));
      if (args.workspaceId) await recordUsage(args.workspaceId, provider, result);
      return { text: result.text, model: result.model, provider };
    } catch (e) {
      errors.push(`${provider}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  throw new Error(`All AI providers failed:\n${errors.map((e) => `  • ${e}`).join('\n')}`);
}
