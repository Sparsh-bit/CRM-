# Phase 9 — Web/Social Research

Turns the Research and Social/Content Research agent templates into real
research employees: real web search, real page extraction, real Instagram
metadata (within what an anonymous request can actually see), and a real
uploaded-video pipeline (metadata, transcription, optional frame analysis).
No fake scraping, no fabricated Instagram results, no placeholder "AI
analyzed this reel" text — every failure mode returns a structured, honest
result instead of guessing.

## Architecture

```
web_search / fetch_web_page / analyze_web_content
  -> SearchService (src/lib/research/search.ts) — pluggable, honest not_configured
  -> WebFetchService (src/lib/research/webFetch.ts) — SSRF-guarded, bounded
  -> extract.ts (Readability over jsdom) — clean text, bounded length
  -> cache.ts (ResearchCache) — 24h TTL, public pages only
  -> analyze.ts -> the EXISTING AI provider router (ai/provider.ts)
       -> structured result (zod-validated), never free text

analyze_social_content (Instagram only)
  -> instagram.ts — real anonymous-request Open Graph read, or a
     structured { status: "unavailable", reason, suggestions } result

analyze_uploaded_media (any video/audio upload)
  -> creates a MediaAsset (POST /api/research/media) + a MediaAnalysis row
  -> enqueues a `process_media` Job — returns immediately (Section 4/14:
     never block an AgentRuntime tool call on ffmpeg)
  -> the EXISTING worker (src/worker/index.ts) picks it up
  -> media/pipeline.ts: ffprobe -> extractAudio -> transcribe (Groq/OpenAI
     Whisper) -> optional sampleFrames + vision (only if VISION_MODEL is
     configured) -> analyze.ts's reel-analysis prompt -> structured result
  -> get_media_analysis polls the result
```

Every AI step reuses `src/lib/ai/provider.ts` (or its new
`transcribe.ts`/media `vision.ts` siblings, which read the SAME
`GROQ_API_KEY`/`OPENAI_API_KEY` credentials) — no second AI integration.

## Supported content

| Input | What's real | What's honestly reported unavailable |
|---|---|---|
| A public web page | Full Readability-extracted text + AI analysis | A page that needs login, is script-rendered with no server HTML, returns non-2xx, or resolves to a private/internal address |
| An Instagram post/reel URL | Open Graph `title`/`description`/`image` an anonymous request can see | The actual video/audio (Instagram never exposes this to an anonymous request); a private/age-gated/deleted post (detected via the login-page redirect) |
| Any other social platform URL | Nothing — explicitly unsupported | Reported as unsupported, with a suggestion to upload the file instead |
| An uploaded video/audio file | Real ffprobe metadata, real audio extraction + transcription (if a transcription provider is configured), real structured content analysis | Frame/visual analysis (only if `VISION_MODEL` + a provider key are configured — genuinely real when it is, never a stub when it isn't) |

## Instagram limitations (Section 16)

No login bypass, no anti-bot evasion, no scraping library that pretends to
be the mobile app — `src/lib/research/instagram.ts` makes exactly the
request an anonymous browser tab would make and reads exactly what comes
back. Concretely, this means:

- A **public** post's title/caption/thumbnail are usually readable.
- A **private, age-gated, or deleted** post redirects to Instagram's login
  page — detected and reported as `unavailable`, never guessed at.
- The **actual video/audio is never retrievable** this way — Instagram does
  not serve it to an anonymous request. `analyze_social_content` never
  returns a `videoUrl`; the honest path for real video/audio content is
  **upload the file** and call `analyze_uploaded_media`.

## Web search configuration (Section 7)

`SearchService` (`src/lib/research/search.ts`) never hard-codes a provider.
Set `SEARCH_PROVIDER` to one of:

- `searxng` + `SEARXNG_URL` — a self-hosted SearXNG instance. No API key, no
  per-query cost. **Not SSRF-checked** — `SEARXNG_URL` is operator-configured
  deployment config (very commonly a private IP/localhost/Docker-network
  address for a self-hosted instance), not attacker- or agent-influenced
  input, so the SSRF guard (meant for arbitrary URLs an agent decides to
  fetch) does not apply to it.
- `brave` + `BRAVE_SEARCH_API_KEY` — Brave Search API, for a deployment that
  would rather not run its own SearXNG.

Unset (or an unknown value): `webSearch()` returns `{ status:
"not_configured", reason }` — never a fabricated result.

## Page extraction (Section 8)

`WebFetchService` (`src/lib/research/webFetch.ts`) is the one place this
codebase fetches an arbitrary external URL:

- Manual redirect following (`redirect: 'manual'`), capped at 5 hops, with
  the SSRF guard **re-run on every hop** — a hostname that resolves to a
  public IP today can still redirect to a private one.
- Response body capped at `RESEARCH_FETCH_MAX_BYTES` (default 5MB), the
  stream itself aborted once the cap is hit, not truncated after the fact.
- Whole-request timeout `RESEARCH_FETCH_TIMEOUT_MS` (default 15s).
- Every failure (invalid URL, non-2xx, unsupported content-type, timeout,
  network error, oversized body) returns `{ ok: false, reason }` — never
  throws where a caller would have to guess what happened.

Extraction (`extract.ts`) uses Mozilla's own Readability library (the engine
behind Firefox Reader View) over a jsdom document — mature, MIT-licensed, no
browser automation needed. Extracted text is capped at
`RESEARCH_EXTRACT_MAX_CHARS` (default 20,000) before it ever reaches an AI
prompt (Section 21 cost control).

### SSRF protection (Section 8)

`src/lib/research/ssrf.ts`: blocks `localhost`/`.local`/`.internal`
hostnames outright, resolves every other hostname via DNS and rejects it if
**any** resolved address is private/reserved (10.0.0.0/8, 172.16.0.0/12,
192.168.0.0/16, 127.0.0.0/8, 169.254.0.0/16 — which includes the
169.254.169.254 cloud metadata endpoint, 0.0.0.0/8, 100.64.0.0/10, and the
IPv6 equivalents: `::1`, `fe80::/10`, `fc00::/7`) — a hostname resolving to
both a public and a private address (DNS rebinding) is refused outright
rather than racing which address the eventual request happens to hit.

This guard applies to **every URL an agent/search-result/user decides to
fetch** (`fetch_web_page`, `analyze_web_content`, `analyze_social_content`).
It deliberately does **not** apply to `SEARXNG_URL` (see above) — an
operator-configured deployment setting, not untrusted input.

## Resource limits (Section 14/21)

| Limit | Default | Env var |
|---|---|---|
| Fetched page size | 5MB | `RESEARCH_FETCH_MAX_BYTES` |
| Fetch timeout | 15s | `RESEARCH_FETCH_TIMEOUT_MS` |
| Search timeout | 10s | `RESEARCH_SEARCH_TIMEOUT_MS` |
| Extracted text passed to AI | 20,000 chars | `RESEARCH_EXTRACT_MAX_CHARS` |
| Media processed (audio+frames) | first 180s of any file, however long | `RESEARCH_MEDIA_MAX_DURATION_SEC` |
| Sampled frames per video | 4 (never every frame) | `RESEARCH_MEDIA_FRAME_COUNT` |
| Upload size | 200MB | `RESEARCH_UPLOAD_MAX_BYTES` |
| Cache TTL | 24h | `RESEARCH_CACHE_TTL_MS` |

All read at call time (not module load), so a long-running worker process
picks up a changed value without a restart — the same convention
`ai/provider.ts` already established.

Large media processing never runs inline inside an AgentRuntime tool call
(bounded by `AGENT_TASK_TIMEOUT_MS`, ~2 minutes) — `analyze_uploaded_media`
only creates a `MediaAnalysis` row and enqueues a `process_media` Job,
returning immediately; the real ffmpeg/transcription/vision work happens in
the existing worker process (`src/worker/index.ts`), the same one that
already sends messages and executes agent tasks — no second worker.

## Caching (Section 9)

`ResearchCache` — not workspace-scoped (a public page's extracted text is
the same fact for every workspace), keyed by a normalized URL (fragment and
trailing slash stripped, host lowercased). Stores the extraction result plus
a sha256 of the raw fetched body (so a caller can tell "did this page
actually change" without re-extracting) and an explicit `expiresAt`, checked
in application code, not a DB job. Only ever populated with what an
anonymous `WebFetchService` request could see — nothing gated behind a login
wall (Instagram included) ever reaches this table.

## Storage (Section 20)

No object-storage provider (R2/S3) is configured in this deployment yet.
`src/lib/storage/local.ts` is the simplest legitimate implementation for
what exists today — local disk under `STORAGE_ROOT` (default a temp dir) —
kept behind a narrow save/read/remove-by-key interface so swapping in R2
later is a one-file change. `media/pipeline.ts` deletes the entire working
directory (the original upload included) once a `MediaAnalysis` reaches a
terminal state — nothing is kept around after processing.

## Knowledge / RAG (Section 10)

Explicit-only: `save_to_knowledge` is a normal tool an agent's own task must
choose to call — nothing here is written automatically. Storage is plain
chunked text (`KnowledgeChunk`, ~1000 chars/chunk on paragraph boundaries),
searched with Postgres full-text search (`search_knowledge`). **No
embeddings/vector index in this build** — no pgvector extension is assumed
present, and adding one is a real infrastructure decision (which extension,
which embedding provider, migration plan for existing chunks) that belongs
to its own phase, not a Phase 9 detail. Keyword search over real, explicitly
saved chunks is honest and useful on its own; it is not "RAG" in the
embedding-similarity sense, and this doc does not claim otherwise.

## Prompt-injection resilience (Section 13)

A fetched page, an Instagram caption, or a video transcript is UNTRUSTED
DATA. `src/lib/research/prompts.ts`'s `untrustedBlock()` wraps it in an
explicit delimiter and the system prompt says, twice, not to obey anything
inside it — the same pattern `planner.ts` already established for a user's
raw command text. This is advisory, not the real defense: the real defense
is structural — `analyze_web_content`/`analyze_social_content`/the media
pipeline make exactly ONE completion call with no tool-calling loop, so
there is no channel through which injected text in the content could ever
invoke a tool or reach another system. A jailbroken analysis can only be a
USELESS analysis (or fail its own output-schema validation), never a path
to unauthorized action.

## Agent permissions (Section 12)

| Permission | Tools | Granted to |
|---|---|---|
| `research:web` | `web_search`, `fetch_web_page`, `analyze_web_content`, `get_media_analysis` | Research, Social/Content Research |
| `research:social` | `analyze_social_content`, `analyze_uploaded_media` | Social/Content Research only |
| `research:knowledge` | `save_to_knowledge`, `search_knowledge` | Research, Social/Content Research |

`research:analysis` (CRM/campaign synthesis — `summarize_lead`,
`analyze_campaign_performance`) is unrelated and was **removed** from the
Social/Content Research template — that role researches external content,
not this workspace's own CRM data, matching `templates.ts`'s own
long-standing "no permission a role doesn't need" rule.

`research_external_content` (the honest not-implemented stub from an
earlier phase) was retired — replaced by the real `analyze_web_content`.

## AI usage / local vs. cloud routing (Section 15)

Every text-analysis step goes through the existing `complete()` router — no
new model integration. Two capabilities are genuinely optional, gated on
explicit configuration, and **honestly reported unavailable rather than
faked** when not configured:

- **Transcription** (`src/lib/ai/transcribe.ts`): needs `GROQ_API_KEY` or
  `OPENAI_API_KEY` (both already-used credentials — Whisper is a real
  capability of both, Anthropic has no audio API). Unconfigured: the
  pipeline still runs on whatever else is available (caption/description);
  if nothing is available at all, the analysis fails honestly rather than
  analyzing nothing.
- **Frame/visual analysis** (`src/lib/research/media/vision.ts`): needs an
  explicit `VISION_MODEL` (the default text models — `llama-3.3-70b-
  versatile`, `gpt-4.1-mini` — are not vision-capable, so one is never
  guessed) alongside a Groq/OpenAI key. Real frames are always sampled via
  ffmpeg regardless (cheap, local); the vision **call** only happens if
  configured.

## Tests

`scripts/research-test.ts` (`npm run research:test`) — real Postgres, real
local HTTP fixture server (deterministic, no live-internet dependency), real
ffmpeg against a synthetic test video generated once via `ffmpeg -f lavfi`,
real SearXNG-shaped-JSON parsing over that same local fixture. Only the
AI-provider HTTP boundary (`api.groq.com`) is mocked. Covers: SSRF blocking
(and the private-IP-rejection path specifically, via the real default
guard), valid/invalid/redirected/looping/404/oversized/slow URLs, cache
normalization, search not-configured vs. real-provider parsing,
prompt-injection framing (captures the actual outgoing AI request body and
asserts the untrusted delimiter surrounds the injected text), Instagram
unavailable (a real fetch attempt, not skipped), unsupported platforms,
knowledge save/search via real Postgres full-text search, the full uploaded-
media pipeline through the real worker function (metadata, audio, mocked
transcription, honest-then-real vision gating), unsupported-media failure,
workspace isolation, tool permission denial, and activity logging.

## Known limitations

- **No RAG in the embedding-similarity sense** — `search_knowledge` is
  keyword/full-text search only (see "Knowledge / RAG" above).
- **No search provider ships pre-configured** — `SEARCH_PROVIDER` must be
  set by the deploying operator; `web_search` is honestly `not_configured`
  until then.
- **No object storage** — uploaded media lives on local disk
  (`src/lib/storage/local.ts`) until an R2/S3 decision is made.
- **Only Instagram is a supported social platform** — any other domain is
  reported as unsupported, with a suggestion to upload the file directly.
- **No video URL from Instagram, ever** — by design (Section 16); the
  honest path for real video/audio content is uploading the file.
- **Vision/frame analysis needs explicit configuration** (`VISION_MODEL` +
  a provider key) — genuinely real when configured, honestly unavailable
  otherwise.
- **No frontend UI was built or changed** — Section 19's contracts
  (`POST /api/research/media`, the `analyze_*`/`get_media_analysis` tools)
  are ready for the frontend session to wire up; no file under
  `src/app/workforce` or `src/components` was touched.
