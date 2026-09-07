/**
 * WebFetchService — the one place anything in this codebase fetches an
 * arbitrary external URL. SSRF-safe (src/lib/research/ssrf.ts, re-checked on
 * every redirect hop, not just the first request), bounded in size and time,
 * and honest on failure: every failure mode returns a structured
 * { ok: false, reason } instead of throwing where a caller would have to
 * guess what went wrong.
 */
import { assertSafeUrl, UnsafeAddressError } from './ssrf';

// Read at call time, not module load — same reasoning as ai/provider.ts's
// timeoutMs()/maxRetries(): a module-level const is captured before a test
// can override it, and would survive stale across a long-running worker
// process even if the env var were changed at runtime.
const maxBytes = () => Number(process.env.RESEARCH_FETCH_MAX_BYTES ?? 5_000_000); // 5MB
const timeoutMs = () => Number(process.env.RESEARCH_FETCH_TIMEOUT_MS ?? 15_000);
const MAX_REDIRECTS = 5;
const USER_AGENT = 'Mozilla/5.0 (compatible; OutreachPilotResearchBot/1.0; +https://outreachpilot.local/bot)';

export type FetchPageResult =
  | { ok: true; finalUrl: string; status: number; contentType: string; body: string }
  | { ok: false; reason: string };

/** One hop: fetch with redirects OFF so a 3xx can be re-validated before being followed. */
async function fetchOnce(url: URL, signal: AbortSignal): Promise<Response> {
  return fetch(url, {
    method: 'GET',
    redirect: 'manual',
    signal,
    headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/xhtml+xml,*/*;q=0.8' },
  });
}

/** Reads the body up to maxBytes(), aborting the stream (not just truncating after the fact) once the cap is hit. */
async function readBounded(res: Response): Promise<string> {
  if (!res.body) return res.text();
  const cap = maxBytes();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel();
      throw new Error(`Response exceeded the ${cap}-byte limit.`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf-8');
}

/**
 * `validateUrl` defaults to the real SSRF guard and is never overridden in
 * production code — every real caller (search.ts's own page-fetch users,
 * the tools) calls fetchPage() with no second argument. The override exists
 * ONLY so scripts/research-test.ts can point the exact same redirect/size/
 * timeout-handling code at a local fixture server (127.0.0.1), which the
 * real guard correctly refuses — that refusal is itself tested separately,
 * against the default, by calling fetchPage() with no override at all.
 */
export async function fetchPage(rawUrl: string, validateUrl: (u: string) => Promise<URL> = assertSafeUrl): Promise<FetchPageResult> {
  let url: URL;
  try {
    url = await validateUrl(rawUrl);
  } catch (e) {
    return { ok: false, reason: e instanceof UnsafeAddressError ? e.message : `Invalid URL: ${String(e)}` };
  }

  const controller = new AbortController();
  const ms = timeoutMs();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      let res: Response;
      try {
        res = await fetchOnce(url, controller.signal);
      } catch (e) {
        if (controller.signal.aborted) return { ok: false, reason: `Timed out after ${ms}ms fetching ${url}.` };
        return { ok: false, reason: `Network error fetching ${url}: ${e instanceof Error ? e.message : String(e)}` };
      }

      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        if (hop === MAX_REDIRECTS) return { ok: false, reason: `Too many redirects (>${MAX_REDIRECTS}) starting from ${rawUrl}.` };
        const next = new URL(res.headers.get('location')!, url);
        try {
          url = await validateUrl(next.toString()); // re-check EVERY hop — the whole point of manual redirects
        } catch (e) {
          return { ok: false, reason: e instanceof UnsafeAddressError ? e.message : String(e) };
        }
        continue;
      }

      if (!res.ok) return { ok: false, reason: `${url} responded ${res.status} ${res.statusText}.` };

      const contentType = res.headers.get('content-type') ?? '';
      if (!/text|html|json|xml/i.test(contentType) && contentType !== '') {
        return { ok: false, reason: `Unsupported content-type "${contentType}" at ${url} — only text/html-like responses are extracted.` };
      }

      let body: string;
      try {
        body = await readBounded(res);
      } catch (e) {
        return { ok: false, reason: e instanceof Error ? e.message : String(e) };
      }
      return { ok: true, finalUrl: url.toString(), status: res.status, contentType, body };
    }
    return { ok: false, reason: 'Redirect loop did not resolve.' };
  } finally {
    clearTimeout(timer);
  }
}
