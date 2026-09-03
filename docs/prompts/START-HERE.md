# START HERE — the prompts that begin the build

Copy-paste, in order. Each block is a complete prompt for a fresh agent session.
Run one, check the gate at the bottom of it, commit, move on. Do not run two at
once — T2 through T8 each assume the previous one shipped.

There are two entry points:

- **Path A — build from zero.** You have an empty folder and this `docs/` directory.
- **Path B — continue from the shipped v1.** This repo already contains a working
  v1. Skip to *Session 9* and build v1.1.

---

# Session 0 — Kickoff (run this first, always)

> Paste this into a fresh agent session in the project root.

```
Read these files completely before you respond:
  docs/prompts/00-MASTER.md
  docs/prompts/01-PRD.md
  docs/prompts/02-ARCHITECTURE.md
  docs/prompts/03-BUILD-PROMPTS.md
  docs/prompts/04-AI-AGENT-PROMPTS.md
  docs/prompts/05-QA-AND-LAUNCH.md

SKILLS: superpowers (design + TDD) · ponytail (tie every line to real behaviour) · get shit done (ship it)

We are building OutreachPilot: a multi-tenant bulk email + WhatsApp outreach
platform whose two differentiators are (1) a spreadsheet importer that needs no
mapping wizard and (2) an AI writer that writes one message per lead from that
lead's own row.

Do NOT write any code in this session. Instead:

1. Tell me the build order you intend to follow and why, in your own words. If
   you disagree with the order in 03-BUILD-PROMPTS.md, say so now, not in T5.
2. List the five decisions in this spec you think are most likely to be wrong,
   and what you would do instead. Be specific and be blunt — a spec nobody
   argued with is a spec nobody read.
3. Name the three places where a bug would be most expensive for a real user.
   (Hint: one of them is not "the UI".)
4. Confirm which of superpowers / ponytail / get shit done are actually
   installed in your environment. For any that are missing, say so plainly and
   state how you will apply that discipline by hand.
5. Set up the repo skeleton ONLY: package.json, tsconfig, .gitignore,
   .env.example, and an empty prisma/schema.prisma. Commit it.

GATE: I approve your build order before you start T1.
```

**Why this session exists:** the most expensive failure in agent-built software
is an agent that starts typing before it has an opinion. Point 2 is the whole
point of the session — if the agent has no objections, it has not understood the
spec, and you should re-run this with a better model.

---

# Session 1 — T1 Foundation

> Paste `T1` from `docs/prompts/03-BUILD-PROMPTS.md`, then add:

```
Additional constraints for T1, learned the hard way:

- Use Prisma 7 with the `prisma-client` generator and a driver adapter
  (@prisma/adapter-pg). Prisma 7 is Rust-free — no query-engine binary to
  download, which matters on locked-down networks and cuts deploy size.
- In Prisma 7 the connection URL lives in prisma.config.ts, NOT in
  schema.prisma. A `url` in the datasource block is a hard validation error.
- Build the PrismaClient LAZILY behind a Proxy. `next build` imports every
  module to collect page data; a client constructed at import time makes the
  build demand DATABASE_URL, which is not where a database belongs.
- Every model that has a relation needs BOTH sides declared. Prisma will refuse
  to generate otherwise, and it is easy to add Message.workspace and forget
  Workspace.messages.

GATE: `npx prisma generate` succeeds, `npm run db:push` creates the schema,
`npx next build` succeeds with DATABASE_URL unset, and a new email address
creates a user + workspace + owner membership.
```

---

# Session 2 — T2 Import (spend the most time here)

> Paste `T2` from `03-BUILD-PROMPTS.md`, then add:

```
Test fixture: samples/Outreach_Kit_Tier13.xlsx — a real four-sheet lead workbook.

The expected result, which you must reproduce exactly:
  4 sheets detected, ranked by contactable rows
  "Account Research" ranked first, header row detected at row 3 (there is a
      two-row title banner above it)
  mapped: tier, company, country, city, industry, fullName, title, phone, email
  kept as custom: Pitch, Research Summary, Why This Contact
  "Summary" ranked LAST — it has no contactable rows
  68 rows normalise → 67 valid emails, 59 usable phones, 67 first names resolved,
      67 unique dedupe keys (one duplicate email in the source)

Three cases that WILL bite you, so write them as failing tests first:
  1. "Company Name" must map to company, not be eaten by the contact-name
     pattern. Score every (header, field) pair and assign highest first.
  2. "Dr. Siddeek Ahmed" must yield first name "Siddeek", not "Dr.".
  3. A name cell containing "CEO" or "Managing Director" must yield an EMPTY
     first name, so the template falls back to a neutral greeting instead of
     sending "Hi CEO,".

GATE: `npx tsx scripts/import-test.ts samples/Outreach_Kit_Tier13.xlsx` prints
the numbers above, and `npx tsx scripts/mapping-test.ts` is green.
```

---

# Session 3 — T3 Template engine

> Paste `T3` from `03-BUILD-PROMPTS.md`, then add:

```
The RED test, before any implementation:

  render('{Hi|Hello} {{first_name | fallback: "there"}}, from {{sender_company}}',
         { sender_company: 'Concilio' })
  must contain 'there, from Concilio'

A naive implementation resolves spintax first. `{{first_name | fallback:
"there"}}` contains `{first_name | fallback: "there"}`, which is a perfectly
valid spintax group, so it gets shredded and your users mail their entire list
"Hi { fallback: "there"},". This is not hypothetical — it happened in the
reference build and was caught only because this test existed.

Resolve merge tags FIRST, park each resolved value behind a sentinel character,
run spintax over what remains, then substitute the sentinels back. A resolved
value that itself contains "{a|b}" must come out untouched.

GATE: `npx tsx scripts/template-test.ts` — 12 assertions green.
```

---

# Session 4 — T4 Mailboxes and the governor

> Paste `T4`, then add:

```
The governor (src/lib/scheduler.ts) is a PURE function over plain data. It does
not import the database and it does not know what a Mailbox model is. That is
what lets WhatsApp reuse it in T7 instead of growing a second, subtly different
throttle — which is how one channel ends up ignoring a daily cap.

Write these tests before the implementation:
  - warmup ramp: day 0 → warmupStart; day 4 → warmupStart + 4*warmupStep;
    never above dailyLimit
  - the sent-today counter resets at LOCAL midnight in the workspace timezone,
    not UTC midnight — test with Asia/Kolkata (UTC+5:30)
  - a mailbox at its cap returns { ok: false, reason: 'daily_cap' } with a
    retryAt at the next local midnight, and rotation moves to the next mailbox
    rather than blocking the queue
  - jitter never pushes the gap below minGapSeconds

GATE: those four tests green, and four providers each deliver one real message
to an inbox you control.
```

---

# Session 5 — T5 The AI writer

> Paste `T5`, then add:

```
Use the system prompts in docs/prompts/04-AI-AGENT-PROMPTS.md VERBATIM. Every
rule in them is load-bearing; rule 6 is the "Hi CEO," bug and rule 1 is what
stops the product generating plausible libel about a stranger's business.

Before you call this done, generate drafts for the whole sample workbook and
read TEN of them yourself. Check, honestly:
  - does each one reference something real from its own row?
  - are any two of them nearly identical? (if so, the lead facts are not
    reaching the prompt — fix the fact assembly, not the temperature)
  - did the model invent a single thing the sheet did not say?
  - does the low-confidence flag actually catch the thin rows?

Report what you found, including the bad ones. An agent that reports "all 68
drafts look great" has not read them.

GATE: 68 distinct drafts, a review UI showing lead context beside each one, and
your written assessment of ten of them.
```

---

# Session 6 — T6 Campaigns, preflight, worker

> Paste `T6`, then add:

```
Design the idempotency story BEFORE writing the worker, and write it down:
where exactly does a crash between "SMTP accepted the message" and "the row was
updated to sent" leave you, and what stops the restart re-sending?

The answer must be a database-level unique constraint on
(campaignId, leadId, stepOrder, channel), not an application-level check.

Prove it: launch a campaign against MailHog, `kill -9` the worker mid-flight,
restart it, and assert zero duplicate deliveries. Paste the counts.

GATE: draft → preflight → running → done, survives kill -9, and unsubscribing
mid-campaign cancels every queued message for that lead on every channel.
```

---

# Session 7 — T7 WhatsApp

> Paste `T7`, then add:

```
Evolution API v2 endpoints, verified:
  POST   /instance/create              { instanceName, number, qrcode, integration, webhook }
  GET    /instance/connect/{name}      → { base64, code, pairingCode }
  GET    /instance/connectionState/{name} → { instance: { state: 'open'|'connecting'|'close' } }
  POST   /message/sendText/{name}      { number, text, delay, linkPreview, quoted }
  POST   /message/sendMedia/{name}     { number, mediatype, mimetype, caption, media, fileName }
  POST   /chat/whatsappNumbers/{name}  { numbers: [...] } → does this number exist on WhatsApp
  POST   /webhook/set/{name}
  DELETE /instance/logout/{name}, /instance/delete/{name}
Auth: `apikey` header. Per-instance tokens stored encrypted.
Webhook events to handle: CONNECTION_UPDATE, MESSAGES_UPSERT.

Use /chat/whatsappNumbers at preflight to drop numbers that are not on WhatsApp
before they burn send quota.

Reuse the T4 governor. If the WhatsApp path grows its own throttle, you have
gone wrong — delete it and pass the WhatsApp instance's limits into canSend().

The UI must state, at the point of connecting a number, that this is an
unofficial WhatsApp Web client, that cold outreach gets numbers banned, and that
Meta's Cloud API is the compliant path. Do not bury it in a tooltip.

GATE: QR pairs a number, a campaign sends under the same governor as email, and
an inbound reply stops that lead's sequence and only that lead's.
```

---

# Session 8 — T8 Make it safe to sell

> Paste `T8`, then add:

```
This is the task that decides whether the product can be sold without burning
customers' domains. Work through docs/prompts/05-QA-AND-LAUNCH.md line by line
and report each checkbox as pass or fail with evidence — not "done".

Specifically prove:
  - a sent email's raw source contains List-Unsubscribe AND
    List-Unsubscribe-Post: List-Unsubscribe=One-Click
  - the unsubscribe link works from a browser with no session
  - a workspace physical address appears in the footer
  - the tracking domain is per-workspace, not shared
  - bounce rate and complaint rate are computed and surfaced

Label opens "approximate". Privacy proxies pre-fetch pixels; a product that
reports inflated open rates as fact is lying to its customer.

GATE: every checklist line has a pass with evidence, or an explicit "not done
and here is why".
```

---

# Session 9 — v1.1, in priority order (Path B starts here)

Run these one at a time, same discipline. They are ordered by how much they are
worth, not by how easy they are.

### 9a — Unified reply inbox (the biggest gap vs. every competitor)

```
SKILLS: superpowers · ponytail · get shit done
TASK: 9a — one inbox for replies across email and WhatsApp
DONE WHEN: a reply on either channel appears in a single thread view within 5
minutes and has already stopped that lead's sequence.

- IMAP polling per mailbox (idle where supported, poll otherwise), matched back
  to the Message by In-Reply-To / References, falling back to the recipient
  address plus a time window.
- The Evolution MESSAGES_UPSERT webhook feeds the same thread view.
- An out-of-office auto-reply must NOT count as a reply and must NOT stop a
  sequence — Woodpecker sells this as a feature and it is the single most
  common false positive. Use the reply classifier in 04-AI-AGENT-PROMPTS.md §4.4.
- "unsubscribe" intent always wins over everything else in the message.
```

### 9b — Email verification on import

```
TASK: 9b — verify addresses before the first send, not after the first bounce
DONE WHEN: importing flags risky addresses and keeps them out of sends by default.

Syntax → MX lookup → SMTP RCPT probe with a short timeout → catch-all detection.
Cache per domain. Mark: valid | risky | invalid | catch_all. Only `valid` and
(opt-in) `catch_all` are sendable. Saleshandy and Woodpecker both include this
free at entry tier — it is table stakes, not a premium feature.
```

### 9c — A/B testing per step

```
TASK: 9c — variants with honest reporting
DONE WHEN: a step can hold up to 5 variants, assignment is deterministic per
lead, and the report breaks out open/click/reply per variant with the sample
size shown next to every rate.

Never display a winner on fewer than 100 sends per variant. A 60% open rate on
5 sends is not a result, and showing it as one teaches your customer to make bad
decisions.
```

### 9d — Warmup pool

```
TASK: 9d — mailboxes warm each other
DONE WHEN: opted-in mailboxes exchange and reply to scheduled messages on a
ramp, and warmup traffic is excluded from every customer-facing metric.

Warmup mail must be plausible human correspondence, never templated filler, and
must never touch a real lead. Keep it in a separate table from Message so it
cannot leak into campaign reporting.
```

### 9e — Per-recipient timezone sending

```
TASK: 9e — send at 9am THEIR time
DONE WHEN: a lead in Riyadh and a lead in Mumbai on the same campaign receive
their message inside their own local sending window.

Derive the timezone from the lead's country/city on import, store it on the
lead, fall back to the campaign timezone when unknown, and show the user how
many leads fell back.
```

---

## Rules for every session

1. **State the skills, the task and the gate before you start.** If a skill is
   not installed, say so and apply its discipline manually.
2. **The failing test comes before the implementation.** Every time.
3. **Report what is broken, not what is done.** "All tests pass" from an agent
   that wrote its own tests is worth very little; "here are the two cases I
   could not make work" is worth a lot.
4. **Commit at the end of every session.** A session that ends uncommitted did
   not happen.
5. **Never mark a gate passed without pasting the evidence** — the test output,
   the counts, the raw email headers.
