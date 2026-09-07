# Providers, Dependencies & Commercial Risk Review (Phase 10)

## Connection setup (Section 4) — customer-facing pages, existing service layers

No duplicate provider system was created; every page below calls the one
existing service module for its channel.

| Channel | Page | Service | Connect | Test | Status | Reconnect | Disconnect |
|---|---|---|---|---|---|---|---|
| Email | `/mailboxes` (Phase 1) | `src/lib/email/senders.ts` | Add mailbox form | (implicit — a send either works or the mailbox flips to `error`) | `active`/`paused`/`error` pill | — | Pause (toggle) |
| WhatsApp | `/whatsapp` (Phase 3) | `evolution.ts` | Add instance -> scan QR | "Refresh status" (real `connectionState()` call) | `disconnected`/`qr`/`connected`/`error` | Refresh status | Remove (real `deleteInstance()`) |
| SMS | `/sms` (**new this phase**) | `gateways.ts` (Phase 5) | Add gateway form | "Test connection" (real `checkGatewayConnection()`) | `not_configured`/`disconnected`/`connected`/`error` | Re-enable | Disconnect (soft) / Remove (hard) |

No page ever renders a decrypted credential (`docs/security.md`).

## AI provider configuration

`AI_PROVIDER`/`AI_PROVIDER_CHAIN` — see `docs/deployment.md`'s env table.
Groq first by default, Anthropic/OpenAI as configured fallbacks — unchanged
architecture from Phase 1, reused (not duplicated) by every later phase's
AI usage (writer, planner, research analysis, transcription).

## Dependency & license review (Section 25)

Every package added across Phases 1-10, reviewed for commercial
suitability. **This is an engineering risk review, not a legal opinion —
get a real license/compliance review before commercial launch,
particularly for the WhatsApp item below.**

### Core framework & data
| Package | License | Note |
|---|---|---|
| `next`, `react`, `react-dom` | MIT | Standard, no concern. |
| `@prisma/client`, `@prisma/adapter-pg`, `prisma` | Apache-2.0 | Standard, actively maintained. |
| `pg` | MIT | Standard. |
| `zod` | MIT | Standard. |
| `bcryptjs`, `jose` | MIT | Standard, both actively maintained; `jose` specifically chosen over `jsonwebtoken` for pure-JS/no-native-binding portability (unchanged from Phase 1). |
| `date-fns`, `date-fns-tz` | MIT | Standard. |
| `nanoid` | MIT | Standard. |
| `dotenv` | BSD-2-Clause | Standard. |

### Feature-specific
| Package | License | Note |
|---|---|---|
| `nodemailer` | MIT | Standard, mature. |
| `exceljs`, `papaparse` | MIT | CSV/XLSX import — standard. |
| `@mozilla/readability`, `jsdom` | Apache-2.0 / MIT | Phase 9 page extraction — both mature, widely used (Readability is literally Firefox's own Reader View engine), no concern. |
| `@aws-sdk/client-s3` | Apache-2.0 | Phase 10 R2 backend — official AWS SDK, excellent commercial fit, actively maintained. |

### Dev-only
| Package | License | Note |
|---|---|---|
| `typescript`, `tsx`, `tailwindcss`, `postcss`, `autoprefixer` | MIT/MIT/MIT | Standard, dev/build-time only — never ships in the served app logic. |
| `@reticlehq/next`, `@reticlehq/react` | **Commercial dev tool** — verify its own license terms for this deployment before commercial launch (not a well-known FOSS license situation like the rest of this table). Dev-only (`NODE_ENV==='development'` gate in `layout.tsx`/`reticle-dev.tsx`) — not loaded in a production build regardless. |

### External SERVICES this app is a client of (not vendored code — their own terms apply independently of this codebase's license)

| Service | What it is | Risk |
|---|---|---|
| **Evolution API** (`EVOLUTION_API_URL`, `src/lib/whatsapp/evolution.ts`) | A self-hosted WhatsApp gateway, itself built on **Baileys**, an unofficial reverse-engineered WhatsApp Web client. | **The real commercial risk here is NOT a code license — Evolution API and Baileys are both MIT-licensed.** It's that WhatsApp's own Terms of Service prohibit unofficial/automated clients; a number used this way can be **banned by WhatsApp at any time**, with no recourse, regardless of how correctly this codebase implements the client. This is a standing operational risk for any commercial deployment using this channel, not a bug to fix in code — flag it to the business owner explicitly before relying on WhatsApp for revenue-critical outreach. The existing safeguards (warmup, daily caps, min-gap/jitter, the explicit UI warning already in `/whatsapp`: *"Cold WhatsApp outreach... gets numbers banned"*) reduce but do not eliminate this risk. |
| **httpSMS** (`src/lib/sms/httpsms.ts`) | Turns a customer's own Android phone/SIM into an SMS gateway, via the open-source httpSMS project (MIT-licensed) and its hosted API. | Reliability risk, not a license risk: the "gateway" is a customer's own phone staying online, charged, and connected — an operational dependency outside this app's control. httpSMS's own hosted API terms apply independently. |
| **Resend / SMTP / Gmail / Outlook OAuth** (email) | Standard email-sending providers/protocols. | Standard commercial ToS for each provider — no unusual risk beyond the normal deliverability/anti-spam considerations already documented in Phase 1. |
| **Groq / Anthropic / OpenAI** (AI) | Standard commercial AI API providers. | Standard commercial API ToS — no unusual risk. Token/request usage is now tracked (`docs/usage.md`) so cost exposure is at least visible, not unbounded-and-invisible. |
| **Cloudflare R2** (storage, once configured) | Standard S3-compatible object storage. | Standard commercial ToS — no unusual risk. |
| **SearXNG** (self-hosted, if `SEARCH_PROVIDER=searxng`) | AGPL-3.0-licensed, explicitly designed for self-hosting. | Self-hosting your own instance (not redistributing modified SearXNG code as a product) is exactly its intended, license-compatible use. |
| **Brave Search API** (if `SEARCH_PROVIDER=brave`) | Commercial API. | Standard commercial API ToS. |

### Summary

No dependency added across any phase carries a copyleft obligation that
would affect this codebase's own distribution (the one AGPL item, SearXNG,
is used as a separate self-hosted service, not linked/vendored code). The
one standing **business** (not code) risk worth a human decision before
relying on it commercially is WhatsApp/Evolution/Baileys's ToS exposure,
above — already partially mitigated by existing rate-limiting, not
eliminable by any code change.
