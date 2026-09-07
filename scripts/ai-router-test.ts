/**
 * AI provider router (`src/lib/ai/provider.ts`) — chain selection, retry on
 * transient failures only, and fallback across providers. No real network
 * calls: `global.fetch` is replaced with a script that answers by URL, and no
 * real API keys are needed — only whether a key env var is *set* matters.
 *
 * Usage-event tracking (`recordUsage`) needs a real workspace row via Prisma
 * and is not covered here — it's verified by hand against the running app
 * (see the phase report), matching how requireRole/currentRole are verified.
 */
process.env.AI_RETRIES = '1'; // keep retryable-failure scenarios fast
process.env.AI_TIMEOUT_MS = '2000';

import { complete } from '../src/lib/ai/provider';

let fails = 0;
function check(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { fails++; console.log(`FAIL ${name}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`); }
  else console.log(`pass ${name}`);
}

function withEnv(vars: Record<string, string | undefined>, fn: () => Promise<void>) {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) prev[k] = process.env[k];
  for (const [k, v] of Object.entries(vars)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  return fn().finally(() => {
    for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });
}

const NO_KEYS = { AI_PROVIDER: undefined, AI_PROVIDER_CHAIN: undefined, GROQ_API_KEY: undefined, ANTHROPIC_API_KEY: undefined, OPENAI_API_KEY: undefined };

function okResponse(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200 });
}
const OPENAI_OK = { choices: [{ message: { content: 'hi from openai-shaped' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } };
const ANTHROPIC_OK = { content: [{ type: 'text', text: 'hi from anthropic' }], usage: { input_tokens: 10, output_tokens: 5 } };

let calls: string[] = [];
const realFetch = global.fetch;
function mockFetch(handler: (url: string) => Response | Promise<Response>) {
  // @ts-expect-error - test double, signature intentionally narrower than lib.dom's fetch
  global.fetch = async (url: string) => { calls.push(url); return handler(url); };
}

async function main() {
  // all three keys configured, first (groq) succeeds — no fallback needed
  await withEnv({ ...NO_KEYS, GROQ_API_KEY: 'g', ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'o' }, async () => {
    calls = [];
    mockFetch((url) => okResponse(url.includes('anthropic') ? ANTHROPIC_OK : OPENAI_OK));
    const r = await complete({ system: 's', messages: [{ role: 'user', content: 'hi' }] });
    check('default chain tries groq first', r.provider, 'groq');
    check('only one call made — no fallback needed', calls.length, 1);
  });

  // groq has a transient (500) failure, retries once, then falls back to anthropic
  await withEnv({ ...NO_KEYS, GROQ_API_KEY: 'g', ANTHROPIC_API_KEY: 'a' }, async () => {
    calls = [];
    mockFetch((url) => url.includes('groq') ? new Response('server error', { status: 500 }) : okResponse(ANTHROPIC_OK));
    const r = await complete({ system: 's', messages: [{ role: 'user', content: 'hi' }] });
    check('falls back to anthropic after groq 500s', r.provider, 'anthropic');
    check('groq was retried once before falling back (2 attempts + 1 anthropic call)', calls.length, 3);
  });

  // groq has a non-retryable (401) failure — must NOT retry, move on immediately
  await withEnv({ ...NO_KEYS, GROQ_API_KEY: 'g', ANTHROPIC_API_KEY: 'a' }, async () => {
    calls = [];
    mockFetch((url) => url.includes('groq') ? new Response('bad key', { status: 401 }) : okResponse(ANTHROPIC_OK));
    const r = await complete({ system: 's', messages: [{ role: 'user', content: 'hi' }] });
    check('falls back to anthropic after a groq 401 (no retry)', r.provider, 'anthropic');
    check('groq was called exactly once — 401 is not retryable', calls.length, 2);
  });

  // every configured provider fails — a real error naming all of them
  await withEnv({ ...NO_KEYS, GROQ_API_KEY: 'g', ANTHROPIC_API_KEY: 'a' }, async () => {
    mockFetch(() => new Response('down', { status: 503 }));
    let message = '';
    try { await complete({ system: 's', messages: [{ role: 'user', content: 'hi' }] }); }
    catch (e) { message = e instanceof Error ? e.message : String(e); }
    check('error mentions groq', message.includes('groq'), true);
    check('error mentions anthropic', message.includes('anthropic'), true);
  });

  // legacy AI_PROVIDER pins to exactly one provider, no fallback (backward compat)
  await withEnv({ ...NO_KEYS, AI_PROVIDER: 'openai', OPENAI_API_KEY: 'o' }, async () => {
    calls = [];
    mockFetch(() => new Response('down', { status: 503 }));
    let message = '';
    try { await complete({ system: 's', messages: [{ role: 'user', content: 'hi' }] }); }
    catch (e) { message = e instanceof Error ? e.message : String(e); }
    check('AI_PROVIDER=openai never tries groq or anthropic', message.includes('groq') || message.includes('anthropic'), false);
    check('AI_PROVIDER=openai retried only itself (2 attempts, no fallback)', calls.length, 2);
  });

  // no keys configured at all — clear per-provider "not set" errors, not a crash
  await withEnv(NO_KEYS, async () => {
    let message = '';
    try { await complete({ system: 's', messages: [{ role: 'user', content: 'hi' }] }); }
    catch (e) { message = e instanceof Error ? e.message : String(e); }
    check('unconfigured install reports which keys are missing', message.includes('GROQ_API_KEY is not set'), true);
  });

  global.fetch = realFetch;
  console.log(fails ? `\n${fails} FAILED` : '\nall ai router tests passed');
  process.exit(fails ? 1 : 0);
}

main();
