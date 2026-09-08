# Deployment (Phase 10)

Target stack per the brief: **Cloudflare** (frontend), **Railway**
(backend/worker), **Supabase/Postgres** (database), **Cloudflare R2**
(storage, once configured), **Groq** (AI, with the existing provider
fallback chain).

## `.env.example`

**This session cannot write `.env.example` directly** — every tool tried
(Write, Edit, and a plain shell redirect) was refused by this project's own
file-access permission settings (a deny rule on `.env*` paths), confirmed
again this pass. Respected, not worked around. Copy the block below into
`.env.example` by hand — it is the complete, current set (cross-checked
against every `process.env.*` reference in `src/` and `scripts/` this pass;
see "Environment variable audit" below for the exact method). **Never put
real credentials in `.env.example`** — every value here is already a
placeholder or empty string.

```dotenv
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/outreachpilot?schema=public"
APP_URL="http://localhost:3000"
AUTH_SECRET="change-me-to-a-long-random-string"
# NODE_ENV is set by the platform (Next.js/Railway), not by you — do not set it here.

# --- AI (Groq first, per Section 13 — one provider key is enough) ---
AI_PROVIDER_CHAIN="groq,anthropic,openai"
GROQ_API_KEY=""
GROQ_MODEL="qwen/qwen3.8-27b"
GROQ_WHISPER_MODEL="whisper-large-v3-turbo"
ANTHROPIC_API_KEY=""
ANTHROPIC_MODEL="claude-sonnet-4-5"
OPENAI_API_KEY=""
OPENAI_MODEL="gpt-4.1-mini"
OPENAI_WHISPER_MODEL="whisper-1"
AI_TIMEOUT_MS="30000"
AI_RETRIES="2"
AI_CONCURRENCY="4"
VISION_MODEL=""

# --- Email ---
RESEND_API_KEY=""
GOOGLE_CLIENT_ID=""
GOOGLE_CLIENT_SECRET=""
MICROSOFT_CLIENT_ID=""
MICROSOFT_CLIENT_SECRET=""
MICROSOFT_TENANT="common"

# --- WhatsApp via Evolution API ---
EVOLUTION_API_URL="http://localhost:8080"
EVOLUTION_API_KEY=""
EVOLUTION_WEBHOOK_SECRET=""

# --- SMS via httpSMS (per-gateway API key is stored encrypted in the database, not here) ---
HTTPSMS_BASE_URL="https://api.httpsms.com"
HTTPSMS_TIMEOUT_MS="15000"

# --- Web search (Section 7 — optional, honestly not_configured if unset) ---
SEARCH_PROVIDER=""
SEARXNG_URL=""
BRAVE_SEARCH_API_KEY=""

# --- Web/social research resource limits (sane defaults — override only if needed) ---
RESEARCH_FETCH_MAX_BYTES="5000000"
RESEARCH_FETCH_TIMEOUT_MS="15000"
RESEARCH_SEARCH_TIMEOUT_MS="10000"
RESEARCH_EXTRACT_MAX_CHARS="20000"
RESEARCH_CACHE_TTL_MS="86400000"
RESEARCH_MEDIA_MAX_DURATION_SEC="180"
RESEARCH_MEDIA_FRAME_COUNT="4"
RESEARCH_UPLOAD_MAX_BYTES="200000000"

# --- Storage (local default; set STORAGE_PROVIDER=r2 + the four R2_* vars to switch) ---
STORAGE_PROVIDER="local"
STORAGE_ROOT=""
R2_ACCOUNT_ID=""
R2_ACCESS_KEY_ID=""
R2_SECRET_ACCESS_KEY=""
R2_BUCKET=""

# --- Worker / AgentRuntime / Command Center tuning (sane defaults) ---
WORKER_TICK_MS="5000"
WORKER_BATCH="25"
AGENT_MAX_TOOL_CALLS="10"
AGENT_TASK_TIMEOUT_MS="120000"
COMMAND_MAX_TASKS="8"

# --- Reticle (dev-only browser verification — never used in production) ---
# NEXT_PUBLIC_RETICLE_URL=""
# NEXT_PUBLIC_RETICLE_TOKEN=""
# NEXT_PUBLIC_RETICLE_ROOT=""
```

`NEXT_RUNTIME` also appears in a `process.env` reference
(`src/instrumentation.ts`) but is **not** a variable you set — Next.js sets
it itself to distinguish the Node runtime from the edge runtime, which is
exactly what that check uses it for (the edge runtime has no worker and
never touches secrets). It does not belong in `.env.example`.

| Variable | Purpose | Secret? | Required |
|---|---|---|---|
| `DATABASE_URL` | Postgres connection string (Supabase or any Postgres) | yes | **Always** |
| `AUTH_SECRET` | Signs session cookies, derives the AES-256-GCM key that encrypts every stored credential | yes | **Always** — fatal in production if unset or the published example value |
| `APP_URL` | Base URL for tracking pixels/click links/unsubscribe links | no | **Always** — fatal in production if unset, localhost, or non-https |
| `NODE_ENV` | `development`/`production` — gates every fatal-vs-warn check in `env.ts` | no | Set by the platform, usually |
| `AI_PROVIDER` / `AI_PROVIDER_CHAIN` | Which AI provider(s) to try, in order (`groq,anthropic,openai`) | no | One provider key below, at minimum |
| `GROQ_API_KEY` / `GROQ_MODEL` / `GROQ_WHISPER_MODEL` | Groq — the default/first provider | yes (key) | Recommended (per Section 13's "Groq initially") |
| `ANTHROPIC_API_KEY` / `ANTHROPIC_MODEL` | Anthropic fallback | yes (key) | Optional |
| `OPENAI_API_KEY` / `OPENAI_MODEL` / `OPENAI_WHISPER_MODEL` | OpenAI fallback + Whisper alternative | yes (key) | Optional |
| `AI_TIMEOUT_MS` / `AI_RETRIES` / `AI_CONCURRENCY` | AI call tuning | no | Optional (sane defaults) |
| `VISION_MODEL` | Enables real frame/visual media analysis (Section 15) — unset means honestly "unavailable", never faked | no | Optional |
| `RESEND_API_KEY` | Resend email provider (one mailbox option among several) | yes | Optional — SMTP/OAuth mailboxes don't need it |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Gmail OAuth mailbox option | yes (secret) | Optional |
| `MICROSOFT_CLIENT_ID` / `MICROSOFT_CLIENT_SECRET` / `MICROSOFT_TENANT` | Outlook OAuth mailbox option | yes (secret) | Optional |
| `EVOLUTION_API_URL` / `EVOLUTION_API_KEY` | Self-hosted Evolution API (WhatsApp) — see `docs/providers.md` for the real risk profile | yes (key) | Optional — only if WhatsApp is used |
| `EVOLUTION_WEBHOOK_SECRET` | Authenticates inbound Evolution webhooks — **set this if you use WhatsApp**; unset means the webhook accepts an unauthenticated POST (`docs/security.md`) | yes | Strongly recommended whenever WhatsApp is used |
| `HTTPSMS_BASE_URL` / `HTTPSMS_TIMEOUT_MS` | httpSMS API tuning (the SMS gateway's own API key is stored per-gateway in the database, encrypted — not an env var) | no | Optional |
| `SEARCH_PROVIDER` + `SEARXNG_URL` (or `BRAVE_SEARCH_API_KEY`) | Web search backend (Section 7) — unset means honestly `not_configured` | no / yes (Brave key) | Optional |
| `RESEARCH_FETCH_MAX_BYTES` / `RESEARCH_FETCH_TIMEOUT_MS` / `RESEARCH_SEARCH_TIMEOUT_MS` / `RESEARCH_EXTRACT_MAX_CHARS` / `RESEARCH_CACHE_TTL_MS` | Web research resource limits (`docs/research.md`) | no | Optional (sane defaults) |
| `RESEARCH_MEDIA_MAX_DURATION_SEC` / `RESEARCH_MEDIA_FRAME_COUNT` / `RESEARCH_UPLOAD_MAX_BYTES` | Media pipeline resource limits | no | Optional (sane defaults) |
| `STORAGE_PROVIDER` | `local` (default) or `r2` | no | Optional |
| `STORAGE_ROOT` | Local backend's disk root (default a temp dir) | no | Optional |
| `R2_ACCOUNT_ID` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` / `R2_BUCKET` | Required together if `STORAGE_PROVIDER=r2` — fails fast, not a silent local fallback, if incomplete | yes (keys) | Required only if using R2 |
| `WORKER_TICK_MS` / `WORKER_BATCH` | Worker poll interval / batch size | no | Optional |
| `AGENT_MAX_TOOL_CALLS` / `AGENT_TASK_TIMEOUT_MS` / `COMMAND_MAX_TASKS` | AgentRuntime/Command Center bounds | no | Optional (sane defaults) |
| `NEXT_PUBLIC_RETICLE_*` | Reticle dev-only browser verification — never used outside `NODE_ENV=development` | no | Dev only |

### Environment variable audit (this pass)

Method: `grep -rhoE "process\.env\.[A-Z_][A-Z0-9_]*" src/ scripts/` — every
literal `process.env.X` reference in the codebase, deduplicated — diffed
against every variable named in the table above. Result: **exact match**.
Nothing in the table is unused; nothing referenced in code is undocumented,
except the two framework/tooling values that were never meant to be
deployer-set (`NODE_ENV`, set by the platform; `NEXT_RUNTIME`, set by
Next.js itself — both noted inline above rather than listed as
configuration). No obsolete variable was found to remove — this table was
already accurate as of Phase 10; this pass re-verified it rather than
assuming it still was.

## Frontend: Cloudflare — verified this pass: cannot host this app's runtime

This is not a "needs the right adapter" situation — it's a hard, verified
incompatibility. `grep`-ing every `node:*` import actually used in `src/`
turns up `node:child_process` (`src/lib/research/media/ffmpeg.ts`, to run
real `ffmpeg`/`ffprobe` for the media pipeline), `node:dns` and `node:net`
(the SSRF guard's real DNS resolution and IP-range checks,
`src/lib/research/ssrf.ts`), plus `node:fs`, `node:crypto`, `node:os`,
`node:path`, `node:util`. **Cloudflare Workers (and Workers-based Next.js
hosting, including `@cloudflare/next-on-pages`) has no `child_process` at
all** — it's not a missing polyfill `nodejs_compat` adds later, it's a
fundamental constraint of the isolate sandbox: Workers cannot spawn a
subprocess, ever. That alone rules it out for the media-analysis pipeline.
Real outbound TCP for `pg`'s Postgres wire protocol and real DNS resolution
for the SSRF guard are separately unsupported (or require Cloudflare
Hyperdrive plus a different driver, which this app doesn't use). Corrected
from Phase 10's softer wording, which suggested `@cloudflare/next-on-pages`
as a live option — it is not, for this specific application.

**Verified conclusion**: serve the actual Next.js app (web) and the worker
from Railway, exactly as `docs/deployment.md`'s Railway section already
describes — both are plain Node.js processes, which is what this app
needs. Cloudflare's role is CDN/DNS/WAF/TLS in front of Railway (a proxy,
not a host) — point your domain's DNS at Railway through Cloudflare (grey-
clouded or proxied, either works for a plain HTTP(S) reverse proxy) and use
R2 for storage, exactly as already planned. **Not verified against a real
Cloudflare account** (none exists in this environment) — the DNS/proxy
setup itself is a standard, low-risk Cloudflare configuration step, but
confirm it against your actual domain before launch.

## Backend/worker: Railway

Two separate processes, already split cleanly:
- `npm run build && npm start` — the Next.js app.
- `npm run worker` — the background worker (`src/worker/index.ts`), a
  **separate, long-running process** that must be a distinct Railway
  service (or a second dyno/process), not a cron job — it polls
  continuously (`WORKER_TICK_MS`, default 5s) and needs to run all the time
  jobs might exist, not on a schedule.

**Exact Railway setup** (two services from the same repo — Railway does not
auto-split a monorepo into multiple processes from one config file):
1. Create a Railway service from this repo. `railway.json` (added this
   pass) configures it: Nixpacks build (`npm run build`), start command
   `npm start`, health check `/api/health`, restart-on-failure (5 retries).
   This is the **web** service.
2. Create a **second** Railway service from the *same* repo. In its
   Settings, override **Start Command** to `npm run worker` — `railway.json`
   is per-service; the second service needs its own override since Railway
   has no "run two start commands from one file" mode. Give it the same
   environment variables as the web service (below) — it needs
   `DATABASE_URL`, every AI/provider key, and every `RESEARCH_*`/`STORAGE_*`
   var, since it's the one that actually runs AgentRuntime, sends messages,
   and processes media.
3. Set every environment variable from the block above on **both**
   services — Railway does not share env vars between services by default.

**Worker startup**: `main()` immediately calls `console.log('worker up...')`
then loops forever; a crash surfaces as a normal process exit Railway will
restart per its own restart policy (`ON_FAILURE`, matching `railway.json`).
A crashed worker leaves jobs `running`/`locked`; `reclaimStale()` (already
existed, 5-minute default) requeues them the next time the worker restarts.

**Verified this pass, with a real local build**: a production boot
(`NODE_ENV=production`, `next start`) with a fatal config problem (tested:
`APP_URL` pointing at localhost) refuses to serve real traffic — every
route, **including `/api/health` itself**, returns `500` immediately, with
the exact `FATAL` reason logged. The Node process does not hard-exit (it
stays up serving `500`s rather than crash-looping), but Railway's health
check above will correctly mark the deploy unhealthy either way — point it
at `/api/health`, not just "is the process alive."

**Filesystem: ephemeral, not persistent** — Railway containers do not keep
a local filesystem across redeploys/restarts unless you explicitly attach a
Volume. Two real consequences, checked against the actual code:
- `STORAGE_PROVIDER=local` (the default): uploaded media and its processing
  scratch already get deleted right after analysis completes
  (`docs/research.md`) — ephemeral storage is actually the *correct* fit for
  that path, not a gap, **as long as no `MediaAsset` is left `queued` across
  a redeploy** (an unlucky-timing edge case; the pipeline already handles a
  missing file as a real, honest failure — not a crash — if that happens).
- `src/app/lists/page.tsx`'s CSV/XLSX import writes the original file to
  `process.cwd()/uploads/` (a *separate*, older mechanism, predating
  `StorageService` — noted as a known duplication in `docs/architecture.md`)
  and `src/app/lists/[id]/page.tsx` reads it back later. On Railway without
  a Volume, that file is gone after the next deploy — **already
  gracefully handled** (`"Original file is no longer on disk — re-upload
  it"`, an existing, real error path, not a crash), but it means a user
  would need to re-upload their list's source file after every deploy.
  **Recommendation, not implemented this pass** (would be a business-logic
  change beyond this hardening pass's scope): either mount a Railway Volume
  at `process.cwd()/uploads`, or migrate this one upload path onto
  `StorageService`/R2 in a future phase.
- Set `STORAGE_PROVIDER=r2` for production if uploaded media should survive
  a redeploy for longer than "until analysis finishes" for any reason — R2
  is unaffected by Railway's ephemeral filesystem since it's a separate
  service entirely.

**Verify before launch** (needs a real Railway project — not fabricated as
already done): environment variables actually set on BOTH services, not
just one; `DATABASE_URL` reachable from Railway's network to Supabase; the
worker service actually running (Railway won't warn you if you forgot to
add it as a second service); the health check above actually wired into
Railway's own deploy-gating (it does this automatically once
`healthcheckPath` is set and the service redeploys).

## Database: Supabase/Postgres

`DATABASE_URL` works unchanged — this is a plain `pg`/Prisma connection, no
Supabase-specific client used.

**A critical connection-pooling bug was found and fixed this pass**:
`src/lib/db.ts`'s lazily-built client used to skip caching itself in
production, so every single `db.<model>` property access anywhere in the
app opened a **brand-new** `PrismaClient` + a brand-new `pg.Pool` (a
brand-new real Postgres connection) — measured directly against real
Postgres: 6 ordinary calls, 6 new connections, with `NODE_ENV=production`
set (exactly the deployed condition; every previous phase's testing ran in
dev mode, where the bug was inert, which is why it was never caught before
this hardening pass). Fixed to always cache; re-measured after the fix: 6
calls open at most 1 connection, and further calls open zero more.
Regression-tested going forward (`npm run db-singleton:test`). **This was a
deployment blocker** — real traffic against the old code would have
exhausted Supabase's connection limit within moments of going live.

**Connection pooling with Supabase, given the fix**: since there is now
exactly ONE `PrismaClient`/`pg.Pool` per process (default `pg.Pool` max is
10), and there are two processes (web + worker), the real ceiling is at
most ~20 concurrent connections under load — comfortably inside Supabase's
typical direct-connection limit. Either Supabase connection string works:
- **Direct connection** (port 5432) — simplest, fine for Railway's
  long-lived processes (this app is not serverless/edge, so there's no
  cold-start-per-request pressure that direct connections struggle with).
- **Session pooler** — also fine, behaves like a direct connection for this
  adapter's purposes.
- **Transaction pooler** (port 6543, PgBouncer transaction mode) — verified
  from `@prisma/adapter-pg`'s own source (not from a live pooler, no
  Supabase credentials exist in this environment): it does **not** use
  named/server-side-cached prepared statements unless a
  `statementNameGenerator` option is explicitly supplied, which
  `src/lib/db.ts` does not supply — so this adapter should not hit the
  classic "prepared statement does not exist" PgBouncer-transaction-mode
  failure Prisma's own query-engine historically needed `?pgbouncer=true`
  for. **Not verified against a real Supabase transaction pooler endpoint**
  (no credentials available) — confirm with a real connection string before
  relying on it, particularly under concurrent load.

## Storage: Cloudflare R2

`STORAGE_PROVIDER=r2` + the four `R2_*` variables (table above) — see
`src/lib/storage/r2.ts`/`index.ts`. **Not integration-tested in this
session** (no R2 credentials available here) — the code is real (the
official AWS S3 SDK against R2's documented S3-compatible endpoint), but
"real code, untested against the real service" is the honest status; verify
upload/download/delete against a real bucket before relying on it in
production. Local disk remains the default and is not being deprecated —
Section 8: "do not make R2 mandatory yet."

## AI: Groq initially

Already the first provider in the default chain (`AI_PROVIDER_CHAIN`
unset defaults to `groq,anthropic,openai`, filtered to whichever have keys
configured). No code change needed for "Groq initially" — just set
`GROQ_API_KEY` and leave the others unset until/unless a fallback is wanted.

## Migration safety (Section 15)

This repo uses `prisma db push`, not committed migration files — `db push`
diffs the schema against the live database and applies the difference
directly; there is no migration history to review before it runs, and no
build-in confirmation step for a destructive change (a dropped column, a
changed type that can't be cast) beyond Prisma's own interactive prompt,
which does **not** run in CI/non-interactive deploys.

**Safe production procedure** (manual, every time):
1. Run `npx prisma db push` locally against a copy of production data
   first (or at minimum, read the diff Prisma prints — it lists every
   column/table added, changed, or dropped before applying anything
   interactively).
2. Prefer additive changes (Phase 9/10 both added new nullable columns and
   whole new tables — zero drops, zero renames, zero type changes on
   existing columns). This phase's own schema changes to `Workspace`
   (`subscriptionStatus`, `quotaOverrides`, `featureFlags`) are additive
   with defaults — no existing row needed a backfill.
3. **Never** run `prisma db push --accept-data-loss` against production
   without having read exactly what data loss it's accepting — that flag
   exists to skip the interactive prompt, not to make a destructive change
   safe.
4. Back up the database before any schema change that touches an existing
   column (Supabase's own point-in-time recovery, or a manual `pg_dump`).
5. If/when this project moves to committed migrations
   (`prisma migrate`), that's a real infrastructure change deserving its
   own phase, not a Phase 10 detail — noted as a future improvement, not
   implemented here.

## Health checks (Section 17)

`GET /api/health` — real checks: `SELECT 1` against the database, which AI
provider keys are configured, pending/running/recently-failed job counts,
and whether the job queue looks stale (oldest pending job over 5 minutes
old — the honest proxy for "is a worker actually running", since the web
process can't otherwise tell). Returns `503` only when the database check
itself fails; every other field is informational. Point Railway's/your
platform's health-check config at this endpoint.

## CORS / cookies / security config

No CORS headers are set anywhere — every page is same-origin server-rendered
(no browser JS calls a cross-origin API), and the two machine-facing routes
(`/api/webhooks/evolution`, tracking pixel/link routes) are meant to be hit
cross-origin by design (a webhook, an email client loading an image) and
don't need CORS to work. `POST /api/research/media` is same-origin only
(called from `requireSession()`-gated server code, never intended as a
public browser-JS upload target) — if a future frontend calls it via
client-side JS from the SAME origin, no CORS header is needed either.

Session cookie (`src/lib/session.ts`): `httpOnly`, `sameSite: 'lax'`,
`secure` in production, signed JWT (`jose`, `HS256`) — reviewed in
`docs/security.md`.

## File upload / temporary file cleanup

Covered in depth in `docs/research.md` ("Storage", "Resource limits") and
`docs/usage.md` — summarized: uploads are size/mime-capped before touching
disk, processing scratch files (audio/frames) always live under
`os.tmpdir()` and are deleted in a `finally` block regardless of success or
failure, and the original upload itself is deleted once its analysis
reaches a terminal state (no long-term persistent-media retention policy
exists yet — see `docs/security.md` "Data retention").

## Production logging

Plain `console.log`/`console.error` throughout — no structured logging
library, no external log aggregator. Sufficient for Railway's own log
capture; **not** sufficient to search/alert on a specific error pattern at
scale. Adding one (e.g. pino) is a reasonable next step, not attempted here
per Section 17's "do not add an expensive observability stack unless
necessary."
