# SMS Integration (Phase 5)

SMS as a first-class channel, built on the existing send pipeline — no
second worker, no second queue, no second governor, no direct dependency on
httpSMS outside `src/lib/sms/`.

## Architecture

```
Campaign (channel: "sms") / buildQueue()
  -> Message row (channel: "sms", same table as email/whatsapp)
  -> existing Job queue (enqueue 'send_message' — unchanged job type)
  -> existing worker (src/worker/index.ts — unchanged dispatch)
  -> sendDueMessages() -> sendViaSms()
  -> scheduler.ts canSend() (the SAME governor email/WhatsApp use)
  -> SmsService.sendSms()          <-- src/lib/sms/index.ts, the only
  -> httpSMS adapter                    abstraction the rest of the app
  -> customer's Android phone/SIM        may depend on
```

Nothing outside `src/lib/sms/` imports `./httpsms` directly. `sendSms()`
switches on `gateway.provider` exactly like `email/senders.ts`'s
`sendEmail()` switches on `mailbox.provider` — adding a second SMS provider
later (Twilio, another gateway) means adding a case to that switch, not
touching `sender.ts`, `campaign.ts`, or any caller.

## SmsService (`src/lib/sms/index.ts`)

- `sendSms(gateway, { to, text, requestId? })` → `{ providerId }`. Throws on
  any failure — never resolves unless the provider actually confirmed
  submission.
- `testConnection(gateway)` → one of `connected | invalid_credentials |
  device_unavailable | provider_unavailable | not_configured`, with a
  human-readable message. See "Connection lifecycle" below for exactly what
  each one means and does not mean.

## httpSMS adapter (`src/lib/sms/httpsms.ts`)

Implemented against the real, documented API — verified against the
official Node client source
([github.com/NdoleStudio/httpsms-node](https://github.com/NdoleStudio/httpsms-node))
and the server's own route definitions
([github.com/NdoleStudio/httpsms](https://github.com/NdoleStudio/httpsms),
`api/pkg/handlers/phone_handler.go`), not guessed:

- Base URL `https://api.httpsms.com` (override: `HTTPSMS_BASE_URL`, used by
  this integration's own tests to point at a local mock — never set this in
  production).
- Auth: `x-api-key: <key>` header.
- `POST /v1/messages/send` — body `{ from, to, content, request_id? }`. We
  pass `Message.trackingId` (already unique per row) as `request_id`, so a
  duplicate call — a retried job, a race — is also deduped **on httpSMS's
  side**, not just ours.
- `GET /v1/phones` — every phone registered on the account. Used only for
  the connection check.
- Timeout: `HTTPSMS_TIMEOUT_MS` (default 15000ms).
- Error classification (same philosophy as `ai/provider.ts`'s provider
  router): 401 → `invalid_credentials`; 429 → `rate_limited` (retryable);
  5xx → `provider_error` (retryable); other 4xx → `invalid_request`
  (permanent).

## Schema (additive only)

- `SmsGateway` — same shape as `Mailbox`/`WaInstance`: workspace-scoped,
  `provider` (default `"httpsms"`), `phoneNumber` (the registered "from"
  number — the customer's own device), `apiKeyEnc` (encrypted with the
  existing `src/lib/crypto.ts` — no second secret-storage mechanism),
  `status`, `dailyLimit`/`minGapSeconds`/`jitterSeconds`/`sentToday`/
  `sentTodayDate`/`lastSentAt`/`lastError`.
- `Message.smsGatewayId` (nullable FK, same pattern as `mailboxId`/
  `waInstanceId`) and `Message.channel` now documents `sms` as a third
  valid value (it was always a plain string — no enum, no migration needed
  for the value itself).
- `Workspace.smsGateways` relation array (virtual, no physical column).

## Governor reuse

`sendViaSms()` calls the exact same `canSend()` from `src/lib/scheduler.ts`
that email and WhatsApp use — same daily-limit/warmup-disabled/min-gap/
jitter logic, same round-robin-by-`lastSentAt` gateway selection. Sending
windows (`Campaign.sendStartHour/sendEndHour/sendDays`) are checked once,
before the channel dispatch, so SMS inherits them automatically — nothing
SMS-specific was added or could bypass them.

## Duplicate protection

Two layers, both already existing, both simply extended to the `sms`
channel value rather than reimplemented:

1. **App-level**: `buildQueue()`'s existing `db.message.findFirst({
   campaignId, leadId, stepOrder, channel })` check before creating a row —
   already channel-parameterized, needed no change.
2. **Provider-level**: `Message.trackingId` (unique per row already) is
   passed as httpSMS's `request_id`, so even a genuinely duplicated HTTP call
   is deduped by httpSMS itself.

There is still no automatic message-level retry for a *failed* send, for any
channel — see "A bug found and fixed," below, and "Error handling."

## Connection lifecycle — what "Connected" actually means

httpSMS's public API does **not** expose a live "is this phone online right
now" flag on `GET /v1/phones` — that state is tracked server-side via
heartbeat events, not returned to API callers. So:

- **`connected`** means: the API key is valid, **and** a phone matching the
  configured number is registered on the account. It does **not** mean the
  Android app is open and reachable at this exact moment.
- **`device_unavailable`**: the key is valid but no phone matches the
  configured number — the app likely isn't installed/logged in on that
  device, or the number was mistyped.
- **`invalid_credentials`**: the API key itself was rejected (401).
- **`provider_unavailable`**: a network error, timeout, or 5xx from httpSMS
  — the provider itself, not the credentials, is the problem.
- **`not_configured`**: no API key or phone number set yet.

**"API connected" is never claimed to mean "SMS delivered."** A successful
`sendSms()` call means httpSMS accepted the message for queueing to the
phone (`message.status: "pending"` in its own response) — not that the
phone sent it, and not that the carrier delivered it. This build has no
delivery-webhook integration, so `Message.status = "sent"` here means
"successfully submitted to httpSMS," exactly parallel to what "sent" already
means for email (SMTP/API accepted it) and WhatsApp (Baileys accepted it) in
this codebase — none of the three channels currently confirm carrier/
recipient-side delivery.

## Error handling

| Condition | Classification | Behavior |
|---|---|---|
| 401 (bad key) | permanent | `Message.status = "failed"`, no retry |
| 400/422 (bad request/recipient) | permanent | `Message.status = "failed"`, no retry |
| 429 (rate limited) | retryable | `Message.status = "failed"` — see below |
| 5xx (provider error) | retryable | `Message.status = "failed"` — see below |
| timeout / network error | retryable | `Message.status = "failed"` — see below |

**"Retryable" is a real, preserved classification (`HttpSmsError.retryable`,
logged) but does not currently trigger an automatic resend** — this
matches the *existing, pre-existing* behavior of the email and WhatsApp
paths exactly: `sendDueMessages()` has never had automatic message-level
retry for any channel; a failed send just stops, and a human decides what to
do next (re-run the campaign, fix the number, etc.). Extending SMS with its
own retry loop while the other two channels have none would be the "second,
inconsistent system" the brief said not to build. If message-level retry is
ever added, it belongs in `sendDueMessages()` for all three channels at
once, not as an SMS-only feature.

## A bug found and fixed (affects email and WhatsApp too)

Testing the governor against SMS surfaced a real, pre-existing defect in
`sendDueMessages()`'s dispatch (`src/worker/sender.ts`), not introduced by
this phase: `sendViaEmail`/`sendViaWhatsApp` return a `Date` (never `null`)
when blocked by a mailbox/instance's cap or gap, and the guarding check was
`if (!r)` — which is always `false` for a `Date` object (any object is
truthy in JS), so a blocked send was silently treated as sent:
`scheduleFollowUp` fired for a message nothing was sent for, and the lead
was marked `"contacted"` regardless. Fixed at the root (`if (r !== true)`),
verified for all three channels — `scripts/sender-governor-test.ts` (new)
proves it for email and WhatsApp specifically; `scripts/sms-test.ts` proves
it for SMS. No prior test in this codebase exercised this path — there was
no scheduler/governor-level test before this phase.

## Security

- API keys encrypted at rest with the existing `src/lib/crypto.ts`
  (AES-256-GCM, keyed off `AUTH_SECRET`) — the same mechanism as
  `Mailbox.smtpPassEnc` and `WaInstance.tokenEnc`. No plaintext key ever
  touches a log line or an error message (`HttpSmsError` messages include
  the response body, never the request headers).
- Gateway management (`src/lib/sms/gateways.ts`: create/update/delete) is
  admin-role-gated the same way `src/lib/agents/agents.ts` gates AI-employee
  management — the caller resolves the actor's role from the database;
  `atLeast()` makes the actual decision inside the service.
- Every read/write is workspace-scoped (`findFirst` with `workspaceId` in
  the where-clause) — a gateway from another workspace is indistinguishable
  from one that doesn't exist.

## Limitations

- Only one provider (httpSMS) is implemented. The abstraction is ready for
  a second (Twilio, another gateway) without touching any caller.
- No delivery-webhook integration — `sent` means "accepted by the phone's
  API," not "carrier-delivered," for any of the three channels.
- No automatic message-level retry, for any channel (see above).
- Backend only — no `/sms` settings page exists yet. `src/lib/sms/
  gateways.ts` is the complete, tested surface a future page wires up
  (create, update, delete/disable, test connection, list, get), following
  exactly the relationship `src/lib/agents/agents.ts` has to a future
  Workforce settings page.
- **Agents cannot send SMS in this phase.** `SmsService` exists as
  infrastructure only; connecting an Outreach agent's propose/send action to
  it (through `Approval`, through this exact same `Message`/worker path) is
  Phase 6.

## Future provider extension point

To add a second provider: implement its client (mirroring
`src/lib/sms/httpsms.ts`'s shape — a `sendMessage()` that returns a provider
message id, and whatever the provider offers for a connection check), add a
`case` to `sendSms()`'s and `testConnection()`'s switches in
`src/lib/sms/index.ts`, and nothing else changes — not `sender.ts`, not
`campaign.ts`, not the schema (provider is already a plain string column).
