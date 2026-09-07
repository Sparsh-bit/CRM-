/**
 * SearchService — the Research Agent never depends on a specific search
 * provider (Section 7); it calls webSearch() and gets back either real
 * results or an honest "not configured", the same "no fake, no silent
 * fallback" idiom this codebase already uses for AI providers
 * (src/lib/ai/provider.ts) and SMS gateways.
 *
 * Two provider shapes, chosen by SEARCH_PROVIDER:
 *  - "searxng": a self-hosted SearXNG instance (SEARXNG_URL) — no API key,
 *    no per-query cost, AGPL-licensed and explicitly designed to be
 *    self-hosted (not redistributed), which is exactly this deployment.
 *  - "brave": Brave Search API (BRAVE_SEARCH_API_KEY) — a commercially
 *    licensed, actively maintained REST API with a stable JSON contract and
 *    a free tier, for a deployment that would rather not run its own SearXNG.
 * Unset (or an unknown value): honestly not_configured. No provider is ever
 * silently substituted for another.
 */
export type SearchResult = { title: string; url: string; snippet: string };
export type SearchResponse =
  | { status: 'ok'; provider: string; results: SearchResult[] }
  | { status: 'not_configured'; reason: string }
  | { status: 'error'; reason: string };

const timeoutMs = () => Number(process.env.RESEARCH_SEARCH_TIMEOUT_MS ?? 10_000); // read at call time (see webFetch.ts)

async function withTimeout<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs());
  try { return await fn(controller.signal); } finally { clearTimeout(timer); }
}

async function searchViaSearxng(query: string, limit: number): Promise<SearchResponse> {
  const base = process.env.SEARXNG_URL;
  if (!base) return { status: 'not_configured', reason: 'SEARXNG_URL is not set.' };

  // SEARXNG_URL is operator-configured deployment config, not attacker- or
  // agent-influenced input — a self-hosted SearXNG very commonly lives on a
  // private IP or localhost (a Docker network, a LAN box), so the SSRF guard
  // (meant for arbitrary URLs an agent/search-result decides to fetch) is
  // deliberately NOT applied here. Only `query` (an untrusted value) goes
  // into a URL search-param, never into the host/path.
  let url: URL;
  try {
    url = new URL(`${base.replace(/\/+$/, '')}/search`);
  } catch (e) {
    return { status: 'error', reason: `Invalid SEARXNG_URL: ${e instanceof Error ? e.message : String(e)}` };
  }
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'json');

  try {
    const res = await withTimeout((signal) => fetch(url, { signal, headers: { accept: 'application/json' } }));
    if (!res.ok) return { status: 'error', reason: `SearXNG responded ${res.status}.` };
    const j = (await res.json()) as { results?: { title?: string; url?: string; content?: string }[] };
    const results = (j.results ?? []).slice(0, limit).map((r) => ({
      title: r.title ?? '(untitled)', url: r.url ?? '', snippet: r.content ?? '',
    }));
    return { status: 'ok', provider: 'searxng', results };
  } catch (e) {
    return { status: 'error', reason: `SearXNG request failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}

async function searchViaBrave(query: string, limit: number): Promise<SearchResponse> {
  const key = process.env.BRAVE_SEARCH_API_KEY;
  if (!key) return { status: 'not_configured', reason: 'BRAVE_SEARCH_API_KEY is not set.' };

  const url = new URL('https://api.search.brave.com/res/v1/web/search');
  url.searchParams.set('q', query);
  url.searchParams.set('count', String(Math.min(limit, 20)));

  try {
    const res = await withTimeout((signal) => fetch(url, {
      signal, headers: { accept: 'application/json', 'x-subscription-token': key },
    }));
    if (!res.ok) return { status: 'error', reason: `Brave Search responded ${res.status}.` };
    const j = (await res.json()) as { web?: { results?: { title?: string; url?: string; description?: string }[] } };
    const results = (j.web?.results ?? []).slice(0, limit).map((r) => ({
      title: r.title ?? '(untitled)', url: r.url ?? '', snippet: r.description ?? '',
    }));
    return { status: 'ok', provider: 'brave', results };
  } catch (e) {
    return { status: 'error', reason: `Brave Search request failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}

export async function webSearch(query: string, limit = 8): Promise<SearchResponse> {
  const provider = (process.env.SEARCH_PROVIDER ?? '').toLowerCase();
  if (provider === 'searxng') return searchViaSearxng(query, limit);
  if (provider === 'brave') return searchViaBrave(query, limit);
  return { status: 'not_configured', reason: 'No SEARCH_PROVIDER is configured (set SEARCH_PROVIDER=searxng with SEARXNG_URL, or SEARCH_PROVIDER=brave with BRAVE_SEARCH_API_KEY).' };
}
