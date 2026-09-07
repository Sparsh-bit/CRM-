# Architecture Overview (Phase 10)

A map of the whole system as of Phase 10, cross-referencing the phase docs
that already cover each piece in depth rather than repeating them.

## The whole flow

```
Signup (src/app/login) -> Workspace created -> /onboarding
  -> Profile/company info (Workspace.senderName/senderCompany/companyBlurb)
  -> Connect Email (/mailboxes) / WhatsApp (/whatsapp) / SMS (/sms)
  -> Create AI employees (built-in templates, src/lib/agents/templates.ts)
  -> Workforce (/workforce): tasks, research, outreach proposals, approvals
  -> Approval -> Message -> Job -> worker -> real send (Email/WhatsApp/SMS)
  -> tracking (opens/clicks/replies) -> Usage (/usage) -> Quotas enforced
```

## One database, one job queue, one worker

Every background operation — sending a message, executing an agent task,
analyzing media, polling WhatsApp connection state — goes through the SAME
`Job` table (`src/lib/queue.ts`) and the SAME worker process
(`src/worker/index.ts`, `npm run worker`). There is no second queue, no
second worker, anywhere in this codebase — verified again in this phase's
final audit (below).

## Layer map

| Layer | Where | Doc |
|---|---|---|
| Tenancy, auth, roles | `src/lib/session.ts`, `Workspace`/`Membership` | this doc, `docs/security.md` |
| Email/WhatsApp/SMS sending | `src/worker/sender.ts`, `src/lib/{email,whatsapp,sms}/` | `docs/sms-integration.md`, `docs/providers.md` |
| Campaigns, leads, tracking | `src/lib/campaign.ts`, `src/lib/email/tracking.ts` | (Phase 1, no dedicated doc) |
| AI Workforce (agents, tasks, tools, approvals) | `src/lib/agents/*` | `docs/agent-tools.md`, `docs/agent-outreach.md` |
| Command Center (multi-step plans) | `src/lib/agents/commandCenter.ts` | `docs/command-center.md` |
| Web/social research, media analysis | `src/lib/research/*` | `docs/research.md` |
| Usage tracking + quota enforcement | `src/lib/usage/*` | `docs/usage.md` |
| Storage (local disk / R2) | `src/lib/storage/*` | `docs/research.md` (media), `docs/deployment.md` (R2 setup) |
| Onboarding | `src/lib/onboarding/*`, `src/app/onboarding` | `docs/onboarding.md` |

## What's deliberately NOT built (Phase 10 boundary, Section 24)

Payment provider integration, subscription checkout, a large public API,
mobile app, additional communication providers, unrestricted autonomous
agents, SSO, advanced team/agency management. `Workspace.plan`/
`subscriptionStatus`/`quotaOverrides`/`featureFlags` exist as **state**
(`docs/usage.md`) — nothing charges a card or checks one.

## Known duplication (found in this phase's final audit, not fixed — see "Do not create unnecessary churn")

`src/app/lists/page.tsx`'s CSV/XLSX import upload writes directly to
`process.cwd()/uploads/` via plain `node:fs`, predating
`src/lib/storage/` (Phase 9/10). It works and is untouched by this phase —
rewriting a working upload path just to consolidate onto StorageService
would be exactly the kind of churn Phase 10 was told not to create. Worth
unifying in a future phase; flagged here so it isn't rediscovered as a
surprise.

## Backend contracts ready for the frontend (Section 11/19, cumulative)

Nothing under `src/app/workforce` or `src/components` was touched by any
backend-session phase. Ready-but-unwired-by-the-frontend contracts as of
Phase 10:
- Phase 7: Command Center (`previewCommand`/`executeCommand`/etc.)
- Phase 9: research/media tool results, `POST /api/research/media`
- Phase 10: `getUsageSummary()`, `getOnboardingStatus()` — real data, no UI
  built specifically to surface them beyond `/usage` and `/onboarding`
  (which ARE real pages, just not under the frontend session's owned paths)
