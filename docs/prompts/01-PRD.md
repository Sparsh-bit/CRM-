# 01 — Product requirements

## The user

A 2–15 person sales team or agency in the Gulf/India/SEA mid-market. They buy or
build lead lists in Excel, then send from Gmail or a company SMTP box, one at a
time or through a clumsy mail-merge add-on. They also use WhatsApp heavily,
because in their markets WhatsApp gets answered and email often does not.

What they currently cannot do:

- Personalise beyond `{{first_name}}` without writing every email by hand.
- Send from more than one mailbox without manually splitting the list.
- Know who opened, who clicked, who replied.
- Stop a sequence the moment someone replies.
- Run email and WhatsApp from one list without maintaining two of everything.

## Competitive baseline (verified September 2026)

| Capability | lemlist | Instantly | Smartlead | Saleshandy | Woodpecker | Mailshake | **OutreachPilot v1** |
|---|---|---|---|---|---|---|---|
| Entry price | $55/mo | $47/mo | $39/mo | $34/mo | usage: $7/100 prospects | $45/mo | self-host / your own keys |
| Unlimited mailboxes | yes | yes | yes | yes | yes | 2–5 by tier | yes |
| Inbox rotation | yes | yes | yes | yes | yes | — | **yes** |
| Warmup | yes | yes | add-on | included, IP rotation | 4 free, $5 each after | — | **ramp built in**, pool in v1.1 |
| Email verification | credits | credits | credits | **included free** | **included free** | — | v1.1 (9b) |
| Multichannel email + WhatsApp | yes | email-first | email-first | email-first | email + LinkedIn ($29/acct) | email-first | **yes, day one** |
| AI writer | lemAgent | AI Email Writer | — | AI sequences + A-Z testing | AI writer + interest detection | — | **per-lead, full-row context** |
| Unified reply inbox | yes | Unibox | yes | yes | centralised inbox | yes | v1.1 (9a) |
| Out-of-office filtering | — | — | — | — | **yes** | — | v1.1 (9a) |
| A/B testing | yes | yes | yes | A-Z testing | up to 5 versions | yes | v1.1 (9c) |
| Per-recipient timezone | yes | yes | yes | yes | **yes** | — | v1.1 (9e) |
| Spintax | yes | yes | yes | yes | **yes** | — | **yes** |
| Domain audit (SPF/DKIM) | yes | yes | SmartDelivery | yes | **yes, free** | — | v1 panel (T8) |
| Agency / whitelabel | Enterprise | $500/mo | $29/client/mo | Enterprise | $27/client/mo | — | roadmap, priced low |
| Lead database | 650M | 450M | credits | 852M contacts | Lead Finder credits | 50–12.5k credits | bring your own |
| Spreadsheet import | mapping wizard | mapping wizard | mapping wizard | mapping wizard | mapping wizard | mapping wizard | **auto, multi-sheet, zero wizard** |

Every one of these products makes the user configure a mapping wizard. Not one
of them reads a four-sheet workbook with a title banner and works out where the
headers are.

**Where we win:** the import experience, per-lead AI grounded in the whole row,
WhatsApp as a first-class channel rather than an add-on, and a price floor of
"your own API keys" for self-hosters.

**Where we must not lose badly:** deliverability, and the reply inbox. Instantly
and Smartlead sell dedicated IP infrastructure; Woodpecker and Saleshandy give
away email verification and warmup that we charge nothing for yet. v1 answers
the deliverability half with strict caps, warmup ramps, throttling with jitter,
one-click unsubscribe, suppression lists and honest documentation about domain
setup — not with infrastructure we do not have. The reply inbox is the one
genuine hole in v1 and it is the first item in the roadmap for that reason.

**Pricing models in the market.** Three shapes: per-seat/per-tier (lemlist,
Instantly, Smartlead, Saleshandy), per-mailbox (Mailshake), and usage-based per
contacted prospect (Woodpecker, $7 per 100). Woodpecker's shape is the most
honest for small teams and the easiest to explain — worth offering as an
alternative to the flat tiers below once billing exists.

## v1 scope (built)

Multi-tenant workspaces · spreadsheet import with auto sheet + column detection ·
merge tags with fallbacks, filters and spintax · template campaigns · AI
per-lead writer with human review · SMTP / Resend / Gmail OAuth / Outlook OAuth ·
mailbox rotation, daily caps, warmup ramp, throttle + jitter · sending windows by
weekday, hour and timezone · WhatsApp via self-hosted Evolution API with QR
pairing · open, click, reply and unsubscribe tracking · suppression list ·
follow-up steps with stop-on-reply · preflight validation · DB-backed job queue
and worker.

## v1.1 — the next four things, in order

1. **Unified inbox.** IMAP polling per mailbox plus the Evolution webhook, so
   replies land in one thread view and auto-stop the sequence. This is the
   single biggest gap versus the incumbents.
2. **Email verification on import.** MX + SMTP probe, mark risky addresses,
   keep them out of sends. Protects the sender reputation that everything else
   depends on.
3. **A/B testing per step,** with a per-variant open/click/reply breakdown.
4. **Warmup pool.** Workspaces opt in; the system sends and replies between
   member mailboxes on a schedule to build reputation.

## v2 — what makes it sellable at scale

Agency whitelabel and sub-workspaces · custom tracking domains (essential —
a shared tracking domain will eventually get blocklisted) · AI reply
classification (interested / not now / wrong person / unsubscribe) with
auto-routing · CRM sync (HubSpot, Pipedrive, Zoho) · public REST API and
webhooks · LinkedIn step via the user's own session · deliverability placement
testing · usage-based billing.

## Pricing hypothesis

| Plan | Price | Cap |
|---|---|---|
| Self-hosted | free, open | your own keys and infrastructure |
| Starter | $29/mo | 3 mailboxes, 1 WhatsApp number, 5k sends |
| Growth | $79/mo | 15 mailboxes, 5 numbers, 50k sends, AI writer included |
| Agency | $249/mo | unlimited mailboxes, whitelabel, 10 client workspaces |

Undercut Smartlead's $39 Base with a $29 Starter that includes WhatsApp — which
none of them include at entry price — and make AI writing a Growth feature
rather than a credit meter, because credit meters are the most complained-about
part of every competitor's pricing page.

## Compliance, stated plainly

- **Email.** CAN-SPAM, GDPR and the UAE/KSA equivalents require a real physical
  address, a working opt-out, and honest headers. Ship an address field in
  workspace settings and append it to every email before charging anyone money.
- **WhatsApp.** Cold messaging numbers that never opted in violates WhatsApp's
  Business Messaging Policy and gets numbers banned. The Evolution/Baileys
  transport is an unofficial WhatsApp Web client — convenient, and explicitly
  against WhatsApp's terms. The product must say so in the UI (it does), keep
  volumes low, and offer the official Cloud API as the compliant path for
  customers who need one. Do not market WhatsApp blasting.

  If a customer moves to the official Cloud API, the economics changed on
  1 July 2025: Meta now charges **per message, not per conversation**. Marketing
  templates are always charged; utility and authentication templates are free
  inside an open customer-service window and charged outside it; all non-template
  messages inside an open window are free; service conversations have been free
  since November 2024. A Click-to-WhatsApp ad or Page CTA opens a 72-hour free
  window. Cold outreach is by definition a marketing template outside any window
  — the most expensive category there is. Price that into any plan that offers it.
