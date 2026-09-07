# Security Audit (Phase 10)

A real review pass (Section 18) — findings below, fixed where fixing was
in-scope and cheap, documented honestly where it wasn't.

## Authentication / sessions

`src/lib/session.ts`: signed JWT (`jose`, HS256) in an `httpOnly`,
`sameSite: 'lax'` cookie, `secure` in production, 30-day expiry. Role is
read from the database on every `requireRole()` call, **not** trusted from
the cookie — a demoted/removed admin loses access immediately rather than
retaining it for up to 30 days (the comment in `session.ts` names this
explicitly as the reason). `AUTH_SECRET` is fatal-if-missing/example-value
in production (`env.ts`) — it both signs sessions and derives the
credential-encryption key, so a weak/default value is a total compromise,
not a minor one.

## Role checks / workspace isolation

Every admin-level write (`agents.ts`, mailboxes/whatsapp/sms pages,
policies) calls `requireAdmin`/`requireRole('admin')` before touching
anything. Every real read/write across the whole codebase scopes by
`workspaceId` — verified by construction in Phase 2-9's own tests
(`"a different workspace cannot see/update this X"` appears in nearly every
`scripts/*-test.ts` file) and re-checked in this phase's own audit (below).

**Found and fixed this phase**: `src/lib/research/media/pipeline.ts`'s
`runMediaAnalysis()` looked up a `MediaAnalysis` by bare id with no
workspace filter. Not exploitable by any current caller (the Job payload
that supplies the id is only ever created by the same, already
workspace-scoped tool call that also created the Job itself), but exactly
the shape of bug that would silently process the wrong tenant's data the
day that invariant breaks — fixed to `runMediaAnalysis(workspaceId, id)`,
filtering by both, matching the convention `executeAgentTask` already uses.
Regression-tested (`scripts/research-test.ts`: "runMediaAnalysis(wrong
WorkspaceId, id) is a real no-op").

Audited (not changed — already correct): every other bare-id
`findUnique`/`findFirst` in the codebase (`commandCenter.ts`, `tasks.ts`'s
`taskDepth`, `outreach.ts`'s message lookups, `runtime.ts`'s status re-read)
takes an id that was already resolved through a workspace-scoped query
earlier in the same call chain — safe by construction, not by omission.

## Approval bypass / Command Center authorization

Phase 8's fix (`decideApproval()` as the single authoritative decision path)
and Phase 7's planner/runtime separation (a planner-produced tool call is
independently re-checked by `AgentRuntime` against `Agent.allowedTools` +
the Tool Registry + the tool's own zod schema, regardless of what the
planner output) are unchanged and still hold — re-verified by
`scripts/approval-regression-test.ts` and `scripts/command-center-test.ts`
in this phase's regression run, not just carried forward on faith.

## AI tool permissions

Enforced exclusively by `AgentRuntime` (`runtime.ts`), unconditionally,
regardless of what a task's input names — an agent cannot call a tool whose
`requiredPermission` isn't in its own `allowedTools`, checked on every call.
Phase 9's `research:web`/`research:social`/`research:knowledge` split
followed the same least-privilege convention every earlier permission group
already used.

## Uploaded files / SSRF

`src/lib/research/ssrf.ts` (Phase 9) blocks localhost/private/reserved
IPv4+IPv6 ranges including the cloud metadata address, re-checked on every
redirect hop, applied to every arbitrary URL an agent/search result decides
to fetch — deliberately **not** applied to `SEARXNG_URL` (operator-configured
deployment setting, not attacker input — see `docs/research.md`).
`src/app/api/research/media/route.ts` validates size and mime-type prefix
before writing anything to disk, and every storage key is workspace-scoped
structurally (`storageFor(workspaceId)` — no caller can construct a key
that escapes its own prefix; a `..`/absolute-path sub-key is rejected
outright, tested in `scripts/usage-storage-test.ts`).

## Webhooks

**Found this phase, fixed**: `src/app/api/webhooks/evolution/route.ts`
only checks its `?secret=` query param `if (secret && ...)` — if
`EVOLUTION_WEBHOOK_SECRET` is simply unset, the endpoint accepts an
unauthenticated POST from anyone who finds the URL, letting them fabricate
a WhatsApp connection-state change or a fake "replied" event that silently
stops a real send sequence for a lead who never actually replied. Not made
fatal (a workspace that doesn't use WhatsApp has no real exposure, and this
check has no way to know that per-deployment) but now surfaces as a loud,
persistent warning from `envProblems()` in both dev and production —
previously silent. **Manual step before launch: set
`EVOLUTION_WEBHOOK_SECRET` if WhatsApp is used.**

## Provider credentials

Every stored credential (SMTP password, mailbox/WhatsApp/SMS API key, OAuth
token) is AES-256-GCM encrypted (`src/lib/crypto.ts`) before it touches the
database, keyed from `AUTH_SECRET`. No page ever renders a decrypted value
back to the browser — `/mailboxes`, `/whatsapp`, `/sms` only ever show
status/metadata, never the credential itself.

## Data retention (Section 19)

**No automatic expiry/deletion exists for any of the tables below** — this
is the honest current behavior, not a policy decision this phase is making
unilaterally (Section 19: "where retention isn't implemented, document the
current behavior rather than inventing a destructive policy" — how long to
keep an audit trail is a business/compliance decision, not an engineering
default to invent).

| Table | Current behavior |
|---|---|
| `AgentActivityLog` | Kept indefinitely. Deleted only via full workspace cascade. |
| `UsageEvent` | Kept indefinitely — also the raw data `getUsageSummary()`'s rolling 30-day window reads from; deleting old rows would need to preserve enough history for that window first. |
| `ResearchCache` | Has an `expiresAt`, but nothing ever **deletes** an expired row — `getCachedExtraction()` just treats it as a cache miss and re-fetches/overwrites on the next real request. The table grows unboundedly (each row is small: one page's extracted text). |
| `MediaAsset` / `MediaAnalysis` | The pipeline (`docs/research.md`) deletes the underlying file and the whole `MediaAsset` working directory once analysis reaches a terminal state — but the **rows** (`MediaAsset`, `MediaAnalysis`) themselves are kept indefinitely as the audit trail of what was analyzed. |
| `Job` | Kept indefinitely regardless of terminal status (`done`/`failed`). |
| `Message` | Kept indefinitely — this is also the send-history/analytics data campaigns read from. |

A real retention policy (e.g. "purge `AgentActivityLog` after 1 year",
"purge `done` `Job` rows after 30 days") is a genuine product/compliance
decision for a future phase, not invented here.

## Customer/workspace deletion (Section 20)

**There is no customer-facing "delete my workspace" feature in this build**
— the only place a workspace is ever deleted is directly via
`db.workspace.delete()`/`deleteMany()`, used today only by test scripts'
own cleanup. Reviewed anyway, since Section 20 asked specifically:

- **Cascades correctly** (verified at the schema level — every table has
  `onDelete: Cascade` on its `workspaceId` relation, and Phase 2's own test
  explicitly asserts "deleting the workspace cascades every AI Workforce
  table cleanly"): `Membership`, `ApiKey`, `Mailbox`, `WaInstance`,
  `SmsGateway`, `LeadList`, `Lead`, `Campaign` (+ its `CampaignStep`/`Draft`),
  `Message` (+ `Event`), `Suppression`, `Template`, `UsageEvent`, `Agent`
  (+ `AgentTask`/`Approval`/`ApprovalPolicy`/`AgentActivityLog`), `Job`,
  `MediaAsset`, `MediaAnalysis`, `KnowledgeChunk`.
- **`ResearchCache` is intentionally NOT workspace-scoped** (Phase 9: a
  public page's extracted text is the same fact for every workspace) — a
  workspace deletion correctly leaves it untouched; it holds no
  workspace-identifying data to begin with.
- **Found, documented, not silently patched over**: cascading the
  `MediaAsset` row does **not** delete the underlying stored file (local
  disk or R2) if one still exists at deletion time — in the normal flow the
  pipeline already deletes it once analysis completes (`docs/research.md`),
  so this only matters for an asset stuck `queued`/never processed at the
  moment a workspace is deleted. A real fix (hook file cleanup into a
  workspace-delete path) needs that path to exist first — out of scope
  until the feature itself does, but flagged so it isn't a surprise later.
- **External-provider resources are not automatically deprovisioned**: a
  cascade-deleted `WaInstance` leaves its Evolution API instance running
  server-side; a cascade-deleted `SmsGateway` doesn't deregister anything
  with httpSMS. Both need a manual/separate cleanup call
  (`deleteInstance()`/the provider's own console) — documented here per
  Section 20's "where external-provider resources can't be automatically
  deleted, document that behavior."

## Cross-workspace access attempts — tested, not assumed

Every phase's own test suite includes an explicit cross-workspace attempt
(a workspace B trying to read/decide/analyze/delete workspace A's data) and
asserts it fails — re-run in full as part of this phase's regression
(`npm run workforce:test`, `runtime:test`, `tools:test`, `outreach:test`,
`command-center:test`, `approval:test`, `research:test`,
`usage-storage:test` all include at least one such assertion).
