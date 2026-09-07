# Workforce UI ↔ Backend Integration (Phase 8)

Two sessions work on this project: the frontend session owns `src/app/
workforce/*` and `src/components/*`; this phase's job was verifying and
documenting the backend contracts that UI already depends on, not building
or redesigning it. **No file under `src/app/workforce` or `src/components`
was modified this phase** — see "Coordination and the pause," below.

## What the existing Workforce UI already does (inspected, not changed)

All five pages (`/workforce`, `/workforce/agents`, `/workforce/agents/[id]`,
`/workforce/tasks`, `/workforce/approvals`) were already wired to real data
before this phase — no mock data anywhere:

| Page | Real backend it calls |
|---|---|
| `/workforce` (dashboard) | Direct `db.agent`/`db.agentTask`/`db.approval` counts and lists, all `workspaceId`-scoped |
| `/workforce/agents` | `createAgent()` (admin-gated via `currentRole()`), direct `db.agent.findMany` for the list |
| `/workforce/agents/[id]` | `getAgent()`, `listTasks()`, `listApprovals()`, `listActivity()` — all from Phase 2/3's real service layer |
| `/workforce/tasks` | Direct `db.agentTask.findMany` with a status filter |
| `/workforce/approvals` | Direct `db.approval.findMany` (pending/decided split) + `decideApproval()` for the Approve/Reject buttons |

`_lib/status.ts` centralizes label/tone for every `TaskStatus`/
`ApprovalState`/`AutonomyLevel`/agent-status value, with an exhaustiveness
check so an unhandled enum value fails loudly rather than rendering blank —
already correctly aligned with every enum this backend defines.

## A real bug found — fixed at the root

`src/app/workforce/approvals/page.tsx`'s `decide()` server action calls
`decideApproval()` (`src/lib/agents/approvals.ts`) directly. That function
used to be correct only for a *generic* approval — an approval created by an
Outreach agent's `propose_send` tool (Phase 6) needed `decideOutreachApproval()`
(`src/lib/agents/outreach.ts`) instead, the wrapper that actually created the
real, queued `Message` once approved. Approving an outreach proposal through
the UI's own call silently never queued the send.

**Fixed at the root, not in the UI**: `decideApproval()` is now the single
authoritative decision path every caller goes through, including the UI's
`decide()` action, `decideOutreachApproval()`, and any future caller. After
flipping the `Approval`'s status and logging `approval_approved`/
`approval_rejected` (moved here from `outreach.ts` — one logging site, not
two), it checks whether the approval's `actionType` is one of
`outreach.ts`'s `OUTREACH_ACTION_TYPES` (`send_email`/`send_whatsapp`/
`send_sms`) and, if so and the decision is `Approved`, calls
`materializeApprovedMessage()` (now exported from `outreach.ts`) itself. A
generic, non-outreach approval passes through unchanged, exactly as before.

`decideOutreachApproval()` is now a thin wrapper: it calls `decideApproval()`
and reshapes the result into `{ approval, message }` for a caller that wants
the `Message` back (existing tests do) — it no longer decides anything or
duplicates the materialize/log logic itself.

**No frontend file was touched.** `src/app/workforce/approvals/page.tsx`
already called `decideApproval()` directly — that call is now correct on its
own, which is what "the backend determines the correct domain behavior, the
UI only requests Approve/Reject" means concretely here.

This does introduce one real circular import (`approvals.ts` ↔ `outreach.ts`)
— documented at the import site in `approvals.ts`. It's safe: both sides
only touch each other's exports from inside function bodies, never at module
top level, so there is no load-order dependency, and it's confirmed working
by `npm run typecheck` and `npm run build` (same 5 Workforce routes as
before, nothing added or removed).

**Regression coverage**: `scripts/approval-regression-test.ts`
(`npm run approval:test`) drives the exact function the UI calls —
`decideApproval()`, never `decideOutreachApproval()` — for email, WhatsApp,
and SMS: Approve creates a real queued `Message`, a real `send_message`
`Job`, and the expected `AgentActivityLog` entries; Reject creates neither
and logs only `approval_rejected`; a decided approval cannot be decided
again; workspace isolation is enforced (workspace B cannot decide workspace
A's approval); and one approved message is driven end-to-end by a real,
separately spawned `npm run worker` process (not an in-process call) to a
genuine terminal state. `scripts/workforce-ui-integration-test.ts`'s
side-by-side comparison of `decideApproval()` vs. `decideOutreachApproval()`
was updated to assert the fixed behavior (both now create the message)
instead of the old bug.

## Backend contracts ready, not yet wired to any page

- **Phase 7 Command Center**: `previewCommand(workspaceId, text)` (plan
  only, creates nothing), `executeCommand(workspaceId, userId, text)`,
  `getCommand(workspaceId, rootTaskId)`, `listCommands(workspaceId)`,
  `cancelCommand(workspaceId, rootTaskId)` — all in
  `src/lib/agents/commandCenter.ts`. No Command Center page exists in the
  frontend session's file list yet.
- **Task retry**: no `retryTask()` function exists yet (only automatic
  in-runtime retry, per Phase 3). Offered to build it; the frontend session
  asked to hold this too pending their user.

## Coordination and the pause — lifted

Before touching anything, this session messaged the frontend session
(`mailing-software-2d`) with the bug above and the two ready-but-unwired
contracts, asking before making even the fix. Their user then confirmed the
bug and cleared this session to establish the corrected backend contract;
the frontend session asked to be told once it was settled, since they didn't
want to patch their own side independently in the meantime. That contract is
now settled (this doc), and the frontend session has been messaged back with
exactly what to expect: `src/app/workforce/approvals/page.tsx`'s `decide()`
action needs **no change** — it already calls `decideApproval()`, and that
call is now correct on its own.

The Command Center page and task-retry are still paused, untouched, exactly
as before — this round's fix was scoped to the approvals bug only, per
explicit instruction not to redesign the Workforce UI or add new features.

## Tests

`scripts/workforce-ui-integration-test.ts` (`npm run workforce-ui:test`) —
21 assertions replicating each page's own query/call shape directly against
real Postgres (not rendering or driving any page):
- Permission denial: a `member` cannot call `createAgent()`, the exact gate
  `agents/page.tsx`'s `create()` action relies on.
- Agent details: `getAgent`/`listTasks` return the real, workspace-scoped
  data `agents/[id]/page.tsx` renders; verified null/empty across a real
  second workspace.
- Dashboard's exact query set (agent count, active/completed task counts,
  pending-approval count) — verified correct and workspace-isolated.
- The bug above, reproduced with real before/after evidence.
- Approvals list's pending/decided split, exactly as the page queries it.
- Activity feed: real `AgentActivityLog` rows, workspace-isolated.
- Command Center: `previewCommand` creates nothing; a real `executeCommand`
  completes through the real runtime; a malformed plan fails honestly
  (`Failed`, never fake success).

## Browser verification

**Performed, against the real running app via Reticle**, now that the pause
has lifted: dev server started, a fresh real login created a real user +
workspace, a real outreach agent + two real Pending outreach approvals
(email) were seeded directly against Postgres, then driven from
`/workforce/approvals` in a real browser tab:

- Clicked the real **Approve** button → the proposal left "Waiting on you",
  a real `Approved` row appeared in "Recent decisions", and (confirmed
  against Postgres in the same run) the `Approval` had a real `messageId`,
  the `Message` was `queued` on the `email` channel, and a real
  `send_message` `Job` existed.
- Clicked the real **Reject** button → "Waiting on you" went back to
  "Nothing needs your approval right now.", a `Rejected` row appeared, and
  (confirmed against Postgres) `messageId` stayed `null` and zero `Message`
  rows exist for that lead.

Both actions were the actual `decide()` server action wired to the actual
`decideApproval()` call already in `src/app/workforce/approvals/page.tsx` —
no test-only code path, no direct service call standing in for the UI. The
throwaway browser-test workspace/user/data was deleted afterward; the dev
server this session started for the check was stopped afterward too.

## Regression

`npm test`, `workforce:test`, `runtime:test`, `tools:test`, `sms:test`,
`outreach:test`, `command-center:test`, `workforce-ui:test`, and the new
`approval:test` — all pass. `npm run typecheck` and `npm run build` both
clean; the build output lists the same 5 Workforce routes as before this
phase (nothing added, nothing removed) since no frontend file was touched.

## Files changed this phase

Backend fix round (this update):
- `src/lib/agents/approvals.ts` — `decideApproval()` is now the single
  authoritative decision path: logs `approval_approved`/`approval_rejected`
  and materializes an outreach send itself when `actionType` is one of
  `outreach.ts`'s `OUTREACH_ACTION_TYPES`.
- `src/lib/agents/outreach.ts` — exports `OUTREACH_ACTION_TYPES` and
  `materializeApprovedMessage`; `decideOutreachApproval()` is now a thin
  reshape wrapper over `decideApproval()`, no duplicated logic.
- `src/lib/agents/registry.ts` — deleted the dead `_clearRegistryForTests()`
  export (zero callers anywhere).
- `prisma/schema.prisma` — documentation-only comments on `Agent.config` and
  `Approval.affectedRecordIds` explaining their reserved-extensibility
  status (retained, not deleted — no schema shape change, no migration).
- `scripts/workforce-ui-integration-test.ts` — the bug-demonstration
  assertions now assert the fixed behavior.
- `scripts/approval-regression-test.ts` (new) + `package.json`
  (+`approval:test` script).
- `docs/workforce-integration.md` (this file).

Earlier this phase (backend verification/docs round):
- `scripts/workforce-ui-integration-test.ts` (created)
- `package.json` (+`workforce-ui:test` script)

Nothing else. No file under `src/app/workforce`, `src/components`, or any
other frontend path was modified, in either round.

## Known limitations

- No Command Center UI, no task-retry UI/backend function — both offered,
  both still paused by request; out of scope for this round's fix.
- `disableGateway()` (`src/lib/sms/gateways.ts`) looked like dead code on
  first pass but is not — it's part of the same documented, deliberate
  backend-only CRUD surface as `createGateway`/`updateGateway`/
  `deleteGateway` (the file's own header comment: "No page calls this yet
  ... this is the service layer a future /sms settings page wires up to").
  Retained, not deleted.
