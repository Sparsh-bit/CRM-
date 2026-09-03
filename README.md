# OutreachPilot

Bulk email + WhatsApp outreach for people whose leads live in a spreadsheet.

Drop in any lead file — any number of sheets, any column names, title banners
above the headers — and it is read, mapped and imported without a wizard. Then
either write one template with merge tags, or let the AI writer read *every
column of each lead's row* and write a message about that specific business.

---

## What it does

**Import that actually works**
Reads every sheet in a workbook, finds the real header row under title banners,
maps `Designation`→title, `Mobile No.`→phone, `Sector`→industry and a dozen more
patterns, normalises phones to E.164, strips honorifics so nobody gets "Hi Dr.,",
and refuses to greet a spreadsheet cell that says "CEO". Columns it does not
recognise are kept verbatim and become merge tags and AI context.

**Two ways to write**
- *Template mode* — `{{first_name | fallback: "there"}}`, filters (`upper`,
  `title`, `first_word`), and `{spin|tax}` that is deterministic per lead.
- *AI mode* — you supply the purpose; the model writes one message per lead
  grounded only in that lead's row, returns a confidence score, and low-confidence
  drafts are flagged. Nothing sends until you have reviewed them.

**Sending that does not burn your domain**
Multiple mailboxes (SMTP, Resend, Gmail OAuth, Outlook OAuth), least-recently-used
rotation, per-mailbox daily caps, warmup ramp, minimum gap plus jitter, and
weekday/hour sending windows in the recipients' timezone. One governor, one send
path, no bypass.

**WhatsApp as a real channel**
Self-hosted [Evolution API](https://github.com/EvolutionAPI/evolution-api),
QR pairing, the same governor, inbound replies stop the sequence.

**Preflight before launch**
Unresolved merge tags, missing addresses, suppressed contacts and ungenerated
drafts are hard blocks, reported per lead with the fix. "Hi ," never ships.

**Tracking**
Opens, clicks, replies, bounces, one-click unsubscribe with `List-Unsubscribe`
and `List-Unsubscribe-Post`, and a suppression list checked twice — at preflight
and again immediately before send.

---

## Run it

```bash
cp .env.example .env          # set DATABASE_URL, AUTH_SECRET, an AI key
npm install
npx prisma generate
npm run db:push
npm run dev                   # http://localhost:3000
npm run worker                # in a second terminal — nothing sends without this
```

Built on **Prisma 7**, which is Rust-free — there is no query-engine binary to
download or deploy. The connection URL lives in `prisma.config.ts`, not in
`schema.prisma`.

Then: **Settings** (who you are, what you sell) → **Mailboxes** (connect one) →
**Lists** (upload your sheet) → **Campaigns** (template or AI) → review →
**Launch**.

### WhatsApp

```bash
docker run -d --name evolution -p 8080:8080 \
  -e AUTHENTICATION_API_KEY=your-key \
  evoapicloud/evolution-api:latest
```

Set `EVOLUTION_API_URL` and `EVOLUTION_API_KEY`, then create an instance on the
WhatsApp page and scan the QR. Read the warning on that page before you send
anything — this transport is an unofficial WhatsApp Web client and cold outreach
gets numbers banned.

---

## Verify it

```bash
npm test                                                    # 30 assertions, template + mapping
npx tsx scripts/import-test.ts samples/<your-file>.xlsx     # prove the importer on real data
npm run typecheck                                           # needs `prisma generate` first
```

`scripts/import-test.ts` prints every sheet it found, the header row it detected,
the columns it mapped, the columns it kept as custom, and a rendered preview —
run it on a new lead file before trusting an import.

---

## Layout

```
prisma/schema.prisma      data model, workspace-scoped throughout
src/lib/template.ts       merge tags + spintax (merge resolves FIRST — see the comment)
src/lib/scheduler.ts      the one governor: caps, warmup, throttle, windows
src/lib/import/           header detection, column heuristics, normalisation
src/lib/ai/writer.ts      the two system prompts and per-lead fact assembly
src/lib/email/senders.ts  four providers behind one interface
src/lib/whatsapp/         Evolution API client
src/worker/               the only send path
docs/prompts/             the full build spec — read 00-MASTER.md first
```

## Where to take it next

`docs/prompts/01-PRD.md` has the competitor feature matrix, the v1.1/v2 roadmap
and a pricing hypothesis. The four things that matter most, in order: a unified
reply inbox, email verification on import, per-step A/B testing, and a warmup
pool.

## Known limits

- `prisma db push` and `prisma migrate` still need `binaries.prisma.sh` for the
  schema engine. `prisma generate` and the entire runtime do not — the driver
  adapter replaced the query engine. On a network that blocks that host you can
  generate and build, but you must run migrations from a machine that can reach
  it. (`PRISMA_SCHEMA_ENGINE_BINARY=/bin/true npx prisma generate` skips the
  unnecessary fetch; do not use that trick for migrate.)
- Opens are approximate. Privacy proxies pre-fetch pixels; the UI says so.
- Bounce parsing is SMTP-level only. Webhook-based bounce handling per provider
  is a v1.1 task.
