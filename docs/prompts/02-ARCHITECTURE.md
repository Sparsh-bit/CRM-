# 02 — Architecture

## Stack

- **Next.js 15**, App Router, React 19, TypeScript strict, server actions for all mutations.
- **PostgreSQL + Prisma 7**, using the `prisma-client` generator and the
  node-postgres driver adapter. Prisma 7 is Rust-free: no query-engine binary is
  downloaded or shipped, which cuts deploy size and lets `npm install` succeed on
  networks that only allow the npm registry. Every table carries `workspaceId`.
  Two Prisma 7 specifics that will bite anyone porting from v6:
  the connection URL lives in `prisma.config.ts`, not in `schema.prisma`
  (a `url` in the datasource block is a hard validation error); and the client
  is built lazily behind a Proxy in `src/lib/db.ts`, because `next build`
  imports every module to collect page data and would otherwise demand a
  database during the build.
- **Tailwind** for UI. No component library — the surface is small.
- **A DB-backed job queue** (`Job` table) drained by a long-running worker
  process. No Redis in v1: one less thing to operate, and the volumes involved
  (tens of thousands of messages a month) do not need it. Swap in BullMQ behind
  the same `src/lib/queue.ts` interface when a workspace exceeds ~50k sends/month.

## Process model

```
next start          ← UI + API + tracking endpoints + webhooks
npm run worker      ← generates AI drafts, sends messages, polls WhatsApp state
postgres
evolution-api       ← optional, only if WhatsApp is used (docker)
```

The web process never sends. It only enqueues. This keeps a slow SMTP handshake
out of the request path and makes the send path restart-safe.

## Module map

```
src/lib/
  db.ts               Prisma singleton
  crypto.ts           AES-256-GCM encrypt/decrypt for every stored secret
  session.ts          JWT cookie session, requireSession()
  template.ts         merge tags, filters, fallbacks, spintax — MERGE FIRST, SPIN SECOND
  scheduler.ts        sending windows, daily caps, warmup ramp, throttle + jitter
  queue.ts            enqueue / claim / complete / fail / reclaim-stale
  campaign.ts         preflight, buildQueue, scheduleFollowUp, merge context
  import/
    mapping.ts        header→field heuristics, phone/email normalisation, name splitting
    parse.ts          workbook → every sheet, header-row detection, row normalisation
    ingest.ts         rows → Lead upserts, dedupe by email else phone
  ai/
    provider.ts       Anthropic / OpenAI behind one function
    writer.ts         the two system prompts + per-lead fact assembly
  email/
    senders.ts        smtp | resend | gmail_oauth | outlook_oauth, one interface
    tracking.ts       pixel, click rewriting, unsubscribe block and headers
  whatsapp/
    evolution.ts      Evolution API client
src/worker/
  index.ts            poll loop
  sender.ts           the ONLY send path — governor lives here
  drafts.ts           bounded-concurrency AI generation
  wa.ts               connection-state polling
```

## The rule that keeps this honest

**There is exactly one send path** (`src/worker/sender.ts`) and exactly one
governor (`src/lib/scheduler.ts#canSend`). Any feature that needs to send a
message goes through them. A "quick test send" that bypasses the governor is how
a customer's domain gets burned, so it does not exist — a test send is a
one-lead campaign.

## Data model notes

- `Lead.custom` is a JSON blob of every column the mapper did not recognise. It
  is the reason the AI writer can say something specific: the Concilio workbook's
  `Pitch`, `Research Summary` and `Why This Contact` columns land there
  automatically and are handed to the model verbatim.
- `Lead.dedupeKey` is the lowercased email, else the E.164 phone, unique per
  workspace. Re-importing a corrected sheet updates leads instead of duplicating
  them.
- `Draft` exists so AI output is reviewable *before* a `Message` row is created.
  Drafts are editable; edits set `edited = true` and `approved = true`.
- `Message.trackingId` is a nanoid and the only identifier exposed in a URL.
  Nothing in a tracking or unsubscribe link reveals a database id.
- `Suppression` is checked at preflight *and* again immediately before send,
  because a person may unsubscribe while a campaign is mid-flight.

## Column mapping heuristics

`autoMap` scores every (header, canonical field) pair and assigns the highest
scores first, so `Company Name` cannot be stolen by the `fullName` pattern
before `company` gets a chance at it. Verified against the real workbook:

```
Account Research  → header row 3 detected under a 2-row title banner
                     tier, company, country, city, industry, fullName, title,
                     phone, email mapped; Pitch, Research Summary,
                     Why This Contact preserved as custom
Outreach Drafts   → Email Subject, Email Body, Call/WhatsApp Opener preserved
Call Prep         → all six call-prep columns preserved
Summary           → correctly ranked last (no contactable rows)
```

## Deployment

- **Web + worker:** Railway, Render or Fly — anywhere that runs two processes.
  Vercel runs the web half only; the worker needs a long-lived process elsewhere.
- **Postgres:** Neon, Supabase or RDS.
- **Evolution API:** `docker run evoapicloud/evolution-api:latest` with its own
  Postgres and Redis, reachable from the app, never exposed publicly without auth.
- **Tracking domain:** point a subdomain (`track.yourdomain.com`) at the app and
  set `APP_URL` to it. Do not share one tracking domain across tenants in
  production — one customer's spam complaints will poison everyone's links.
