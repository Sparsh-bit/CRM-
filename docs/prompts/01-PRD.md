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

| Capability | lemlist | Instantly | Smartlead | Mailmeteor | **OutreachPilot v1** |
|---|---|---|---|---|---|
| Entry price | $55/mo | $47/mo | $39/mo (Base) | freemium | self-host / your own keys |
| Unlimited mailboxes | yes | yes | yes | n/a | yes |
| Inbox rotation | yes | yes | yes | aliases only | **yes** |
| Warmup pool | yes | yes | yes (add-on) | no | **ramp built in**, pool on roadmap |
| Multichannel (email + WhatsApp) | yes | email-first | email-first | email only | **yes, day one** |
| AI writer | lemAgent | AI Email Writer Agent | — | — | **per-lead, full-row context** |
| AI reply handling | yes | AI Reply Agent | — | — | roadmap |
| Lead database | 650M | 450M | 2k–170k verified credits | — | bring your own |
| Deliverability testing | yes | SISR | SmartDelivery $49+/mo | — | roadmap |
| Whitelabel / agency | Enterprise | Agency $500/mo | $29/client/mo | — | **roadmap, priced low** |
| Spreadsheet import quality | mapping wizard | mapping wizard | mapping wizard | Sheets-native | **auto, multi-sheet, zero wizard** |

**Where we win:** the import experience, per-lead AI grounded in the whole row,
WhatsApp as a first-class channel rather than an add-on, and a price floor of
"your own API keys" for self-hosters.

**Where we must not lose badly:** deliverability. Instantly and Smartlead sell
dedicated IP infrastructure. v1 answers this with strict caps, warmup ramps,
throttling with jitter, one-click unsubscribe, suppression lists, and honest
documentation about domain setup — not with infrastructure we do not have.

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
