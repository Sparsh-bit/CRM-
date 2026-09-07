# Usage & Quotas (Phase 10)

## Architecture (Section 7)

```
Operation (AI call, agent task, message send, research task,
           media analysis, lead import, agent creation)
  -> checkQuota()/checkGaugeQuota()   [src/lib/usage/service.ts]
  -> the real operation runs
  -> recordUsage()                    [only after it actually happened]
```

**One central service, not per-feature logic** (Section 7's explicit
requirement) — every integration point below calls into
`src/lib/usage/service.ts`, never re-implements a limit check itself.

## `UsageEvent` (already existed, Phase 1) — the aggregation layer built around it

`UsageEvent { workspaceId, kind, quantity, meta, createdAt }` already had
every field this phase needed; Phase 10 added the reads (`currentUsage`,
`getUsageSummary`) and the one shared write path (`recordUsage`), not a new
table.

## Tracked kinds (Section 5)

| Kind | Recorded when | Where |
|---|---|---|
| `ai_request` | A provider call **succeeds** (never on a failed/all-providers-failed attempt) | `src/lib/ai/provider.ts`'s `complete()` |
| `ai_tokens` | Same, quantity = real `inputTokens + outputTokens` — **only when the provider actually reported a count**; never estimated (Section 5: "do not fabricate values where the underlying provider doesn't report them") | same |
| `agent_task` | A task is created (`createTask`/`delegateTask` both route through the one function) | `src/lib/agents/tasks.ts` |
| `research_task` | `analyze_web_content`/`analyze_social_content` actually run (real HTTP/AI work was spent, regardless of ok/unavailable outcome) | `src/lib/agents/tools/socialResearch.ts` |
| `media_analysis` | `analyze_uploaded_media` enqueues the real Job (real worker time is about to be spent) | same |
| `message` | `sendDueMessages()` marks a message **`sent`** — never at creation/queue time, never for a failed provider call (Section 7: "do not count a failed provider call as a successful message") | `src/worker/sender.ts` |
| `lead_processed` | A CSV/XLSX import actually creates/updates a real lead — the `skipped` (uncontactable) rows are never counted | `src/lib/import/ingest.ts` |

Gauges (a live value, not an accumulating sum): `agents` (`Agent.count`),
`storage_bytes` (`MediaAsset` size sum). Checked with `checkGaugeQuota()`
against the current live count, not a period window.

## Quota enforcement — exactly where, and what happens when exceeded

| Choke point | Over-quota behavior |
|---|---|
| `complete()` (any AI call) | Throws `QuotaExceededError` **before any provider is contacted** — a blocked request never becomes a real (billable) provider call |
| `createTask()` | Throws before the row is created |
| `createAgent()` | Throws before the row is created (gauge check) |
| `sendDueMessages()` | Treated exactly like a capped/throttled mailbox — the message is left `queued` and retried in an hour, **never marked `failed`, never fake-sent** |
| `analyze_web_content`/`analyze_social_content` | Returns the tool's own honest `{status: 'unavailable', reason}` shape — consistent with every other "can't do this right now" result these tools already return |
| `analyze_uploaded_media` | Throws (same as its existing "asset not found" failure mode) |
| CSV import (`importRows`) | Throws before touching the database, checked against the worst case (`rows.length`) — an import that would exceed quota even if every row succeeded is refused outright, not partially applied |

## Plans, overrides, feature flags (Section 6/12 — configuration, not code)

`src/lib/usage/plans.ts`'s `PLAN_LIMITS` is the **only** place a limit
number lives — no feature checks a hardcoded number itself. Two plans ship
(`free`, `pro`), deliberately generous (a real commercial pricing decision
is out of scope for this phase — Section 6: "do not hardcode commercial
pricing into business logic"). `Workspace.quotaOverrides` (nullable JSON)
overrides any individual key per-workspace without inventing a new plan
name — set directly in the database until an admin UI exists for it.
`Workspace.featureFlags` + `isFeatureEnabled()` exist for the same reason
or a future "disable this workspace's access to X" need; every feature this
build gates is **on** by default (Section 12: no payment integration yet
means no reason to default anything off).

`Workspace.subscriptionStatus` (`active`/`past_due`/`canceled`/`trialing`)
is state only — nothing reads it to block anything yet. It exists so a
future billing-provider webhook has somewhere real to write to, without a
schema change at that point.

## `/usage` page

Read-only, real numbers: `getUsageSummary()`'s period counters and live
gauges, each with a progress bar against its plan limit (or "Unlimited" if
the plan has none set).

## Known limitations

- No per-API-request metering (`api_request` listed in the brief) — there is
  no public API surface yet to meter (Section 11); tracking a metric with
  nothing behind it would be fabricating a number, so it's simply not
  implemented, not faked.
- `PERIOD_DAYS` (30) is a rolling window from "now," not calendar-month
  billing — there's no billing provider to align a calendar cycle to yet.
- Quota checks are per-operation; there's no workspace-wide "kill switch" UI
  yet beyond hand-editing `quotaOverrides` in the database.
