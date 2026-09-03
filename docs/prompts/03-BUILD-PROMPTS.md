# 03 — Module build prompts

Every prompt below is self-contained. Paste one into the agent. Each one opens
with the skill declaration from `00-MASTER.md`; keep it — it is what makes the
agent design before it types.

---

## T1 — Foundation

```
SKILLS: superpowers (design + TDD) · ponytail · get shit done
TASK: T1 — foundation
DONE WHEN: `npm run db:push` creates the schema, `npm run dev` serves a sign-in
page, and a new email address creates a user + workspace + owner membership.

Build the Next.js 15 + Prisma + Tailwind foundation for a multi-tenant outreach
platform.

Requirements
- Prisma schema per docs/prompts/02-ARCHITECTURE.md. Every tenant-scoped model
  carries workspaceId with an index.
- JWT cookie session (jose), httpOnly, 30 days. requireSession() throws.
- Sign-in that creates the workspace on first use of an email address.
- AES-256-GCM helpers for secrets at rest, keyed off AUTH_SECRET.
- Dark UI shell with nav: Dashboard, Lists, Campaigns, Mailboxes, WhatsApp, Settings.

superpowers: propose the schema before writing it; I want to see the model list
and the reasoning about workspace scoping before any migration exists.
ponytail: no auth abstraction beyond what these six pages need. No roles system
until a second role does something different.
get shit done: finish with a working sign-in and a committed migration.
```

---

## T2 — Spreadsheet import (the differentiator — do not rush this)

```
SKILLS: superpowers (design + TDD) · ponytail · get shit done
TASK: T2 — import any spreadsheet without a mapping wizard
DONE WHEN: `npx tsx scripts/import-test.ts samples/Outreach_Kit_Tier13.xlsx`
prints all four sheets with correct header rows and mappings, and 68 leads
normalise with 67 valid emails and 59 usable phones.

Build the importer.

Requirements
1. Read EVERY sheet of an .xlsx/.xls, plus .csv/.tsv. Never assume sheet 1.
2. Detect the header row. Real sheets have title banners and blank spacers above
   it — in the sample workbook the headers are on row 3. Score the first 15 rows
   on distinct short non-empty cells followed by data.
3. Auto-map headers to canonical fields: firstName, lastName, fullName, email,
   phone, company, title, industry, city, country, website, linkedin, tier.
   Score every (header, field) pair and assign highest-confidence first, so
   "Company Name" is not consumed by the contact-name pattern.
   Handle real-world names: "Designation"→title, "Mobile No."→phone,
   "Sector"→industry, "Organisation"→company.
4. Every unmapped column is preserved verbatim in Lead.custom and becomes a
   usable merge tag and AI context. Losing a column is a bug.
5. Normalise phones to E.164 with a configurable default country code; reject
   junk and impossible lengths.
6. Split names properly: strip honorifics (Dr., Eng., Sheikh) so nobody gets
   "Hi Dr.,"; drop bracketed nicknames; return EMPTY for role placeholders
   ("CEO", "Managing Director", "info") so templates fall back to a neutral
   greeting instead of "Hi CEO,".
7. Dedupe by lowercased email, else E.164 phone, unique per workspace. Re-import
   updates rather than duplicates.
8. Rank sheets by contactable rows and default to the best one; let the user
   switch sheets and override any column mapping, then re-import.

superpowers: write the table-driven tests for the mapping heuristics FIRST —
the honorific, role-placeholder, and "Company Name vs Contact Name" cases are
the ones that will regress.
ponytail: no import "framework". Two files: heuristics, and the parser that uses them.
get shit done: ship with a runnable script that proves it against a real workbook.
```

---

## T3 — Merge tags, fallbacks, filters, spintax

```
SKILLS: superpowers (design + TDD) · ponytail · get shit done
TASK: T3 — template engine
DONE WHEN: `npx tsx scripts/template-test.ts` is green, including the case where
spintax sits next to a merge tag that has a fallback.

Build the template engine.

Syntax
  {{first_name}}                      canonical or custom field, case/space insensitive
  {{first_name | fallback: "there"}}  fallback when empty
  {{company | upper}}                 filters: upper, lower, title, trim, first_word
  {a|b|c}                             spintax, deterministic per lead seed

THE TRAP, and the reason this is its own task: a naive implementation resolves
spintax first, and `{{name | fallback: "there"}}` contains `{name | fallback:
"there"}`, which looks exactly like a spintax group. It gets shredded and your
users send "Hi { fallback: "there"}," to their entire list.
Resolve merge tags FIRST, park each result behind a sentinel, run spintax on
what is left, then substitute the sentinels back. Values that themselves contain
braces must survive untouched.

Also return the list of tags that resolved to nothing and had no fallback —
preflight depends on it.

superpowers: the spintax-adjacent-to-fallback case is the RED test. Write it first.
get shit done: ship with the test file committed and passing.
```

---

## T4 — Mailboxes and the sending governor

```
SKILLS: superpowers (design + TDD) · ponytail · get shit done
TASK: T4 — mailboxes, providers, and the one governor
DONE WHEN: four providers send, rotation picks least-recently-used, and a
mailbox at its cap is skipped rather than queued behind.

Requirements
- Providers behind one sendEmail(mailbox, args) interface:
  smtp (nodemailer) · resend (REST) · gmail_oauth (Gmail API, RFC822 base64url)
  · outlook_oauth (Graph sendMail). OAuth access tokens refresh automatically
  from the stored refresh token.
- Secrets encrypted before they reach the database.
- ONE governor, in src/lib/scheduler.ts:
    * daily cap per mailbox, reset on local midnight in the workspace timezone
    * warmup ramp: day 1 = warmupStart, +warmupStep per day, capped at dailyLimit
    * minimum gap between sends, plus random jitter, so sends never look metronomic
    * a sending window: weekdays and hours, in the campaign's timezone
- Rotation: least-recently-used active mailbox that passes the governor.
- Per-mailbox status, sent-today counter, and last error surfaced in the UI.

ponytail: the governor is a pure function over plain data. It does not touch the
database and it does not know what a mailbox is. That is what makes it testable
and what stops a second, subtly different copy appearing in the WhatsApp path.
get shit done: unit-test the ramp and the midnight reset across a timezone boundary.
```

---

## T5 — The AI writer

```
SKILLS: superpowers (design + TDD) · ponytail · get shit done
TASK: T5 — per-lead AI writing with human review
DONE WHEN: a campaign with a one-paragraph purpose produces 68 distinct drafts,
each referencing something real from its own row, all reviewable before send.

Requirements
- Provider-agnostic completion (Anthropic and OpenAI), model configurable per campaign.
- Two system prompts, in docs/prompts/04-AI-AGENT-PROMPTS.md — use them verbatim.
- The user prompt assembles: sender identity, what the workspace sells, the
  campaign purpose, tone, language, word limit, CTA — and then EVERY field of
  that lead's row, including the custom columns nobody mapped.
- Output is strict JSON: subject, body, personalization_note, confidence.
- Drafts land in the Draft table, NOT in Message. Confidence >= 70 auto-approves;
  below that it is flagged for review. Nothing sends until a draft exists and
  preflight passes.
- Generation runs in the worker with bounded concurrency (default 4) and is
  idempotent — regenerating skips leads that already have a draft.
- The review UI shows the lead's company, industry and city next to the draft so
  a human can spot a hallucination in one glance.

superpowers: before coding, write down the five ways this feature hurts a user
(invented facts, "Hi CEO,", wrong language, 400-word essays, all 68 drafts
identical) and make each one a test or a prompt rule.
ponytail: no prompt-template abstraction layer. Two prompts, one builder function.
get shit done: run it against the sample workbook and read ten drafts yourself
before calling it done.
```

---

## T6 — Campaigns, preflight, and the worker

```
SKILLS: superpowers (design + TDD) · ponytail · get shit done
TASK: T6 — campaign lifecycle
DONE WHEN: a campaign goes draft → preflight → running → done, the worker
survives a kill -9 mid-campaign without double-sending, and stop-on-reply works.

Requirements
- Campaign, CampaignStep (multi-step with delayDays and a send condition),
  Message, Event.
- PREFLIGHT is the gate. Hard-blocks: unresolved merge tags with no fallback,
  missing/invalid address for the chosen channel, suppressed contact,
  unsubscribed or bounced lead, AI campaign with a missing draft. It reports
  per-lead, names the company, and tells the user the fix ("add a fallback").
  Launch is disabled while a blocker exists.
- buildQueue materialises step-1 Messages. A unique constraint on
  (campaign, lead, step, channel) is what makes restarts safe — enforce it in
  the database, not in application code.
- The worker: claim job → check window → re-check suppression and reply status →
  send through the governor → record → schedule the follow-up step. Jobs that
  hit a cap are rescheduled, not failed. Stale locked jobs are reclaimed.
- Tracking: open pixel, click rewriting, one-click unsubscribe with
  List-Unsubscribe and List-Unsubscribe-Post headers. Unsubscribing suppresses
  the contact and cancels every queued message for that lead across all channels.

superpowers: design the idempotency story before writing the worker. Where
exactly does a crash between "SMTP accepted" and "row updated" leave you?
get shit done: prove it — kill the worker mid-campaign and restart it.
```

---

## T7 — WhatsApp via Evolution API

```
SKILLS: superpowers (design + TDD) · ponytail · get shit done
TASK: T7 — WhatsApp channel
DONE WHEN: a QR pairs a number, a campaign sends WhatsApp messages under the
same governor as email, and an inbound reply stops that lead's sequence.

Requirements
- Client for github.com/EvolutionAPI/evolution-api v2:
    POST /instance/create              { instanceName, number, qrcode, webhook }
    GET  /instance/connect/{name}      → QR base64 / pairing code
    GET  /instance/connectionState/{name}
    POST /message/sendText/{name}      { number, text, delay, linkPreview }
    POST /chat/whatsappNumbers/{name}  → does this number exist on WhatsApp
    DELETE /instance/logout|delete/{name}
  Auth is the `apikey` header. Per-instance tokens are stored encrypted.
- Webhook receiver for CONNECTION_UPDATE (status) and MESSAGES_UPSERT (reply →
  mark lead replied, cancel queued messages, record the event). Guard it with a
  shared secret.
- WhatsApp uses THE SAME governor as email — lower caps, shorter gaps. Do not
  write a second throttle.
- The UI must state plainly that this transport is an unofficial WhatsApp Web
  client, that cold messaging risks bans, and that the official Cloud API is the
  compliant path. Do not bury it.

ponytail: the WhatsApp send path is ~30 lines inside the existing sender. If it
turns into a parallel subsystem, you have gone wrong.
get shit done: test against a real Evolution container before claiming it works.
```

---

## T8 — Analytics, deliverability hygiene, and the pre-sale checklist

```
SKILLS: superpowers (design + TDD) · ponytail · get shit done
TASK: T8 — make it safe to sell
DONE WHEN: the dashboard reports real rates, and the deliverability checklist in
docs/prompts/05-QA-AND-LAUNCH.md passes end to end.

Requirements
- Per-campaign and per-mailbox: sent, delivered, opened, clicked, replied,
  bounced, unsubscribed, with rates. Opens are inflated by privacy proxies —
  label them "opens (approximate)" rather than pretending otherwise.
- Bounce handling: parse SMTP hard failures, mark the lead bounced, suppress it,
  cancel queued messages.
- Workspace physical address field, appended to every email footer.
- Custom tracking domain per workspace.
- A "deliverability health" panel: SPF/DKIM/DMARC present, bounce rate under 3%,
  complaint rate under 0.1%, daily volume versus mailbox age.

get shit done: this is the task that decides whether the product can be sold
without burning customers' domains. It is not optional polish.
```
