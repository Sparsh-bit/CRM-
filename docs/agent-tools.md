# AI Workforce — Tool Reference

Every tool an agent can call, registered through the central tool registry
(`src/lib/agents/registry.ts`) and enforced exclusively by `AgentRuntime`
(`src/lib/agents/runtime.ts`). An agent's `allowedTools` lists which of the
**permission groups** below it may use — the runtime checks this on every
tool call, unconditionally, regardless of what a task's input names. There is
no other way for an agent to reach this data: agents never import Prisma or
a service module directly.

All tools in this phase are **read-only**. None of them sends a message,
launches a campaign, or changes any data — that remains out of scope until a
later phase, and stays behind the approval system (Phase 2) when it ships.

## Permission groups

| Permission | Tools |
|---|---|
| `crm:read` | `get_lead`, `list_leads`, `search_leads`, `get_lead_activity` |
| `crm:companies` | `list_companies`, `get_company` |
| `campaign:read` | `get_campaign`, `list_campaigns`, `get_campaign_activity` |
| `campaign:analytics` | `get_campaign_metrics`, `compare_campaigns` |
| `sales:prioritization` | `find_high_priority_leads`, `identify_uncontacted_leads`, `identify_replied_leads`, `identify_recently_active_leads`, `summarize_lead_history` |
| `research:analysis` | `summarize_lead`, `analyze_campaign_performance`, `research_external_content` |

Built-in test-only fixtures (`echo`, `test-fail`, `test-fail-safe` — Phase 3)
each require their own single-tool permission and are never assigned to a
real agent template.

## Result shape

Every business tool returns the same envelope:

```json
{ "data": /* tool-specific */, "count": 0, "summary": "human-readable one-liner", "metadata": { "limit": 20, "offset": 0 } }
```

Every list tool takes `limit` (1-100, default 20) and `offset` (default 0),
clamped server-side regardless of what's requested — an agent cannot ask for
an unbounded result set.

## CRM tools (`src/lib/agents/tools/crm.ts`)

There is no `Company` or `Contact` model in this schema. "Company" tools
group `Lead.company`; `get_contact`/`search_contacts` were not added as
separate tools since a `Lead` already *is* the contact record — they would
duplicate `get_lead`/`search_leads` with nothing to differentiate them.

| Tool | Purpose | Input | Read/Write |
|---|---|---|---|
| `get_lead` | One lead by id | `{ leadId }` | read |
| `list_leads` | Filtered, paginated lead list | `{ status?, listId?, tag?, minScore?, createdAfter?, createdBefore?, limit?, offset? }` | read |
| `search_leads` | Case-insensitive substring search across name/email/company/title, plus every `list_leads` filter | `{ query, ...list_leads filters }` | read |
| `get_lead_activity` | A lead's messages + real tracking events | `{ leadId, limit?, offset? }` | read |
| `list_companies` | Distinct `Lead.company` values with a lead count each | `{ limit?, offset? }` | read |
| `get_company` | Aggregated view of one company: lead count, industries, cities, status breakdown, leads | `{ company, limit?, offset? }` | read |

**Known limitation:** there's no `source`/`lastActivityAt` field on `Lead` —
"source" is approximated by `listId` (the import batch), and "last activity"
is only available as a *computed* value (`get_lead_activity`,
`summarize_lead_history`), not a fast filter/sort column on `list_leads`.

## Campaign analytics tools (`src/lib/agents/tools/campaigns.ts`)

| Tool | Purpose | Input | Read/Write |
|---|---|---|---|
| `get_campaign` | One campaign by id, with its step count | `{ campaignId }` | read |
| `list_campaigns` | Filtered, paginated campaign list | `{ status?, channel?, limit?, offset? }` | read |
| `get_campaign_metrics` | Real sent/opened/clicked/replied/failed/unsubscribed counts + rates, per-step breakdown | `{ campaignId }` | read |
| `compare_campaigns` | The same metrics for 2-5 campaigns side by side | `{ campaignIds: string[] }` | read |
| `get_campaign_activity` | Recent per-message activity for a campaign | `{ campaignId, limit?, offset? }` | read |

**What this build does not track** (every `get_campaign_metrics` result
names these explicitly rather than reporting a silent zero):
- **delivered** — no provider delivery-confirmation webhook is wired up.
- **bounced (async)** — no bounce-webhook processing exists yet; `failed`
  (an SMTP-level rejection at send time) is the closest real signal.
- **complaint** — no spam-complaint webhook exists.

`opened`/`clicked` only ever populate for the email channel (tracking pixel +
link rewriting, `src/lib/email/tracking.ts`). `replied` currently only
populates from the WhatsApp inbound webhook
(`src/app/api/webhooks/evolution/route.ts`) — there is no email inbox/IMAP
polling in this codebase, so an email-only campaign's reply rate will always
read as lower than reality.

## Sales intelligence tools (`src/lib/agents/tools/sales.ts`)

| Tool | Purpose | Input | Read/Write |
|---|---|---|---|
| `find_high_priority_leads` | Active leads (excludes bounced/unsubscribed/invalid) ordered by `Lead.score` descending, nulls last | `{ limit?, offset? }` | read |
| `identify_uncontacted_leads` | `status = "new"` | `{ limit?, offset? }` | read |
| `identify_replied_leads` | `status = "replied"` | `{ limit?, offset? }` | read |
| `identify_recently_active_leads` | An open/click/reply within a lookback window | `{ lookbackDays? (1-90, default 7), limit?, offset? }` | read |
| `summarize_lead_history` | Structured message-history rollup for one lead | `{ leadId }` | read |

**No invented scoring.** `find_high_priority_leads` does not compute a new
"AI score" — it sorts by the exact `Lead.score` value your import or
enrichment process already set. A workspace that never populates `score`
will get every active lead back in creation order (nulls last, per the
documented tie-break), which is the honest answer: there is nothing to rank
on until real scoring data exists.

## Research / analysis foundation (`src/lib/agents/tools/research.ts`)

| Tool | Purpose | Input | Read/Write |
|---|---|---|---|
| `summarize_lead` | The fullest structured profile of one lead in one call: canonical fields + every custom imported column (`Lead.custom`, which no CRM tool otherwise exposes) + a real history rollup | `{ leadId }` | read |
| `analyze_campaign_performance` | `get_campaign_metrics` plus a benchmark against this workspace's other campaigns and a few factual, templated observations | `{ campaignId }` | read |
| `research_external_content` | **Not implemented.** Always returns `{ status: "not_configured" }` — never fetches a URL, never fabricates content. Registered now so permission/schema/activity-logging plumbing is ready for a real web-research provider later. | `{ url }` | read (no-op) |

`summarize_company` was considered and **not** added — it would return
exactly what `get_company` (CRM tools) already returns; adding it would be
the duplicate query layer the brief explicitly said to avoid.

Nothing in this file calls an AI provider. These tools assemble real data
into a richer structure; deciding what to *do* with that structure (write a
summary, draft an email) is a reasoning step for a future phase's agent loop,
not something a tool does on its own.

## Agent template tool assignments (`src/lib/agents/templates.ts`)

Configuration only — no seed/onboarding flow writes these to the database
yet; that's future work. Least-privilege: no role gets a permission it
doesn't need for its stated objective.

| Role | Granted permissions |
|---|---|
| CEO / Strategy | `campaign:read`, `campaign:analytics`, `crm:read`, `crm:companies`, `research:analysis` |
| Research | `crm:read`, `crm:companies`, `research:analysis` |
| Sales | `crm:read`, `sales:prioritization`, `campaign:read`, `campaign:analytics` |
| Marketing | `campaign:read`, `campaign:analytics`, `crm:read`, `crm:companies` |
| Operations | `campaign:read` only — job/worker/system-health tools don't exist yet (see Deferred, below) |
| Outreach | `crm:read`, `campaign:read` — read-only context; sending is not implemented for agents in any phase so far |
| Social/Content Research | `research:analysis` only — `research_external_content` is honest about not being implemented, so this agent has nothing else to do until a real provider ships |

## Deferred (intentionally not built this phase)

- `get_contact` / `search_contacts` — no distinct Contact model; would
  duplicate the Lead tools.
- `summarize_company` — would duplicate `get_company`.
- Any job/worker/system-health tool for Operations — no such read surface
  exists in this codebase yet (`Job` rows are visible to the worker only).
- Any tool that sends a message, launches a campaign, or mutates data —
  explicitly out of scope for this phase, and will route through
  `Approval` (Phase 2) when it exists.
- SMS tools — no SMS channel exists in this codebase (`master` branch).
- Real web/social content fetching for `research_external_content` — needs a
  provider decision (and likely a paid API) before implementation.
