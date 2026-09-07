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

## A real bug found (documented, not fixed — see the pause)

`src/app/workforce/approvals/page.tsx`'s `decide()` server action calls
`decideApproval()` (`src/lib/agents/approvals.ts`) directly. That function
is correct for a *generic* approval, but an approval created by an Outreach
agent's `propose_send` tool (Phase 6) needs `decideOutreachApproval()`
(`src/lib/agents/commandCenter.ts`) instead — the wrapper that actually
creates the real, queued `Message` once approved.

**Concrete, reproduced evidence** (`scripts/workforce-ui-integration-test.ts`):
approving an outreach proposal through the currently-wired `decideApproval()`
flips the `Approval` to `Approved` but creates **zero** `Message` rows —
the send is silently never queued. Approving the identical kind of proposal
through `decideOutreachApproval()` correctly creates a real, `queued`
`Message`. Both paths were exercised against real Postgres in the same test
run, back to back, to make the difference undeniable.

The fix is a 2-line change (swap the import and the one function call in
`decide()`) with no UI/JSX change — flagged to the frontend session, who
is holding it for their user's sign-off (see below).

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

## Coordination and the pause

Before touching anything, this session messaged the frontend session
(`mailing-software-2d`) with the bug above and the two ready-but-unwired
contracts, asking before making even the 2-line approvals fix. Their
response: their user has asked to keep the current Workforce UI "exactly as
verified" and paused all three (the approvals fix, the Command Center page,
and task-retry) pending further instructions. This session acknowledged and
held all three — no code under `src/app/workforce` or `src/components` was
touched, and no browser session was driven against their UI while it's
paused for review, consistent with "STOP and coordinate rather than
overwriting" for frontend-owned files.

This is why Phase 8's actual deliverable this round is backend verification
and documentation, not new UI wiring — the wiring itself is one message
away from happening once the pause lifts.

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

**Not performed this phase.** Section 19 asked for real browser flows, but
the frontend session's user has asked to keep the current UI "exactly as
verified" pending their own review — driving it via Reticle while that
review is in progress risked stepping on that process, so this session held
off entirely rather than proceed unilaterally. Will run it once the
frontend session confirms the pause has lifted.

## Regression

`npm test`, `workforce:test`, `runtime:test`, `tools:test`, `sms:test`,
`sender:test`, `outreach:test`, `command-center:test` — all pass, unchanged
from Phase 7. `npm run typecheck` and `npm run build` both clean; the build
output lists the same 5 Workforce routes as before this phase (nothing
added, nothing removed) since no frontend file was touched.

## Files changed this phase

- `scripts/workforce-ui-integration-test.ts` (new)
- `package.json` (+`workforce-ui:test` script)
- `docs/workforce-integration.md` (this file)

Nothing else. No file under `src/app/workforce`, `src/components`, or any
other frontend path was modified.

## Known limitations

- The approvals bug is documented and reproduced, not fixed — waiting on
  the frontend session's user.
- No Command Center UI, no task-retry UI/backend function — both offered,
  both paused by request.
- No browser verification performed this phase, for the same reason.
