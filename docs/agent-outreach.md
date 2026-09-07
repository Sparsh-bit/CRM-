# Agent Outreach (Phase 6)

Connects the AI Workforce to real Email/WhatsApp/SMS execution — through the
existing send path, never around it. An agent never gets a direct line to a
provider; every one of its outbound actions is a proposal, gated by
Approval, that becomes a real `Message` row only once approved.

## Architecture

```
Agent task (propose_send tool call)
  -> proposeOutreach() [src/lib/agents/outreach.ts]
       - autonomy gate (SuggestOnly cannot even open a proposal)
       - recipient/suppression/lead-status validation
       - dedup check (an existing Pending/Approved proposal short-circuits)
  -> createApproval() [Phase 2, unchanged] — resolves immediately if a
     standing ApprovalPolicy exists, else stays Pending for a human
  -> (human decides, or the policy already did) -> materializeApprovedMessage()
  -> real Message row (channel, toAddress, body, agentTaskId, stepOrder: 0)
  -> existing enqueue('send_message', {})            <-- same Job type
  -> existing worker (src/worker/index.ts)             every campaign uses
  -> sendDueMessages() -> sendViaEmail/WhatsApp/Sms()
  -> existing scheduler.ts canSend() governor
  -> EmailService / WhatsAppService / SmsService -> real provider
  -> Message.status: sent | failed
  -> AgentActivityLog: message_sent | message_failed (sender.ts, new)
```

No new worker, no new queue, no new governor, no new provider client. The
only genuinely new code is the proposal→approval→Message bridge
(`outreach.ts`) and two tool files; everything below "real Message row" is
the exact code Phases 0/1/5 already shipped and tested.

## Agent outreach tools (`src/lib/agents/tools/outreach.ts`)

| Tool | Permission | Purpose |
|---|---|---|
| `prepare_email` | `outreach:draft` | Draft a cold email via the existing AI writer (`src/lib/ai/writer.ts`). No send. |
| `prepare_whatsapp` | `outreach:draft` | Same, WhatsApp-length. No send. |
| `prepare_sms` | `outreach:draft` | Same, SMS-length (writer.ts extended with a real `SMS_SYSTEM_PROMPT` this phase — same engine, same "use only supplied facts" rules, no second engine). |
| `propose_send` | `outreach:propose` | The only tool that can lead to a real send. Creates an `Approval`; never calls a provider itself. |

`propose_send`'s proposal deliberately does **not** accept a mailbox/
WhatsApp-instance/SMS-gateway id — the provider is selected exactly the way
it already is for every human campaign: automatically, at send time, by
`sendDueMessages`'s existing round-robin-by-`lastSentAt` governor logic
(`pickMailbox`/the equivalent WhatsApp/SMS loops in `sender.ts`). There is no
"let the LLM choose a provider" capability to defend against, because that
capability was never built — the smallest safe design here is not exposing
it at all, not validating an ID that's never offered.

## Approval flow

Reuses Phase 2's `Approval`/`ApprovalPolicy` exactly:

- **Pending** (no policy): a human calls `decideOutreachApproval(...,
  'Approved' | 'Rejected', decidedBy)`. Approved → a real `Message` is
  created and queued. Rejected → nothing is created, ever, for that
  proposal.
- **Standing policy** (`ApprovalPolicy.decision = AutoApprove`, admin-set):
  `createApproval` (Phase 2) resolves the approval synchronously; this
  phase's addition is that an already-Approved result immediately
  materializes the Message too — no separate human step.
- **Edit**: not a separate code path. An agent (or a future UI) that wants
  to change the content before sending calls `propose_send` again with the
  revised text; the dedup check does not block this because the earlier
  proposal, once rejected, no longer matches (see Idempotency below). A
  *pending* proposal is not silently overwritten — reject it first.

## Autonomy — what it actually gates

`Agent.autonomyLevel` was decorative before this phase (nothing read it).
Now it has one real, tested effect: **`SuggestOnly` cannot open a proposal
at all** — `propose_send` throws immediately (`requireCanPropose` in
`outreach.ts`), before any DB write. `DraftAndRequestApproval`,
`ExecuteApprovedActions` and `Autonomous` all behave identically in this
phase: every one of them still creates a real `Approval` and still requires
either a human decision or an explicit `ApprovalPolicy` — autonomy level
never, by itself, skips human review. The only thing that can ever skip
review is an admin explicitly setting `ApprovalPolicy.decision =
AutoApprove` for that agent + action type (`send_email`/`send_whatsapp`/
`send_sms`) — a deliberate, audited, per-workspace configuration change, not
an inferred consequence of raising an agent's autonomy. This is the literal
meaning of "never bypass approval because the agent has high autonomy
unless the workspace policy explicitly allows it."

The built-in Outreach agent template defaults to `DraftAndRequestApproval`
(not `SuggestOnly`) — its whole objective requires being able to propose,
and this default still creates a real approval for every action; it does
not skip review.

## Email / WhatsApp / SMS integration

Nothing new to say about the providers themselves — Phase 6 adds no
provider code. What's new is that a `Message` can now originate from an
agent (`agentTaskId` set) instead of a human campaign (`campaignId` set,
`agentTaskId` null), and `sendDueMessages` (`src/worker/sender.ts`) logs
`message_sent`/`message_failed` to `AgentActivityLog` when it does. Every
existing check still applies unconditionally to an agent-originated
message: sending-window (campaign-scoped — see Limitations), stop-on-reply,
unsubscribed/bounced lead status, the suppression re-check at send time,
and the exact same daily-limit/min-gap/jitter governor per mailbox/
WhatsApp-instance/SMS-gateway.

## Idempotency / duplicate protection

Three independent layers, each the smallest extension of something that
already existed:

1. **Proposal-level**: `proposeOutreach` looks for an existing
   `Pending`/`Approved` `Approval` for the same `(workspaceId, agentId,
   actionType, leadId)` (a JSON-path query on `proposedContent.leadId`,
   the same query shape already used elsewhere in this codebase) before
   creating a new one. A repeated `propose_send` call — a retried tool
   call, an agent asked twice — returns the existing approval instead of
   opening a second one. A `Rejected` approval does not block a fresh
   proposal (rejection means "not this one," not "never contact this lead
   again" — suppression already handles the permanent case).
2. **Approval-level**: `Approval.messageId` is unique and set exactly once.
   `decideApproval` (Phase 2, unchanged) already throws on a second
   decision for the same approval — "repeated approval" was already
   impossible before this phase.
3. **Provider-level**: unchanged from Phase 5 — `Message.trackingId` is
   passed as httpSMS's `request_id`.

**A real bug found and fixed while building this**: `propose_send` was
initially marked `idempotent: true` in the tool registry, reasoning that a
repeat *call* was safe (true, because of layer 1 above). But the runtime's
`idempotent` flag means something different — "safe to automatically retry
the whole task after a failure" — and every failure mode of `propose_send`
(autonomy denial, suppression, a missing recipient, a cross-workspace lead)
is a permanent validation failure with no network call involved, so an
automatic retry could only ever fail identically. With the flag wrong, a
permanently-invalid proposal was silently requeued as `Queued` instead of
reported as `Failed`. Fixed by setting `idempotent: false` — verified by a
test that specifically checks the task reaches `Failed`, not `Queued`, for
each of those four cases.

## Suppression / opt-out

`proposeOutreach` checks the existing `Suppression` table (same
`value.toLowerCase()` lookup `sendDueMessages` already uses) before ever
creating an `Approval` — a suppressed recipient never gets as far as a
human review. `materializeApprovedMessage` re-checks suppression and lead
status immediately before creating the `Message`, in case time passed
between proposal and a human's decision. `sendDueMessages` then re-checks
suppression a third time at actual send, exactly as it already does for
every human campaign — this phase changed none of that.

## Workspace isolation

Every function in `outreach.ts` takes `workspaceId` explicitly and scopes
every lookup by it — a lead, an approval, an agent from another workspace
is indistinguishable from one that doesn't exist. Verified directly:
proposing outreach to another workspace's lead fails, and deciding another
workspace's approval fails, both tested against a real second workspace,
not asserted from reading the code.

## Activity logged

`message_proposed`, `approval_requested` (only when actually left Pending —
not logged for a policy-resolved one, since nothing was "requested" from a
human), `approval_approved`, `approval_rejected`, `message_created`,
`message_queued`, `message_sent`, `message_failed` — every one the brief
asked for. No duplicate of the existing per-message `Event` model; this is
agent-level context, a different table, a different purpose.

## Tests

`scripts/agent-outreach-test.ts` (`npm run outreach:test`) — 36 assertions
covering all three channels × {proposal, approval, rejection, execution,
failure}, workspace isolation, the four security/bypass cases above, the
standing-policy auto-approve path, and cross-channel proposal dedup. Real
Postgres, external HTTP mocked (Groq for drafting, Resend/Evolution/httpSMS
for sending) — no live provider call.

**Real worker process verified** (not just direct function calls): started
the actual `npm run worker` process against a local mock httpSMS server,
drove a lead through `propose_send` (real runtime, real permission check),
approved it, and confirmed the real worker process — not a test harness —
claimed the resulting `Job`, called the (mocked) provider, marked the
`Message` `sent`, and wrote the `message_sent` `AgentActivityLog` entry with
the correct `agentId`.

## Live providers

No real credential exists in this environment for any provider (Groq,
Anthropic, OpenAI, Resend, Evolution, httpSMS — checked explicitly, all
unset). **Live provider execution was not tested.** Only the real-worker-
against-a-mock path above was verified.

## Limitations

- **Sending windows don't apply to agent-proposed messages.** They're
  campaign-scoped (`Campaign.sendStartHour/sendEndHour/sendDays`), and an
  agent-proposed `Message` has `campaignId: null` by design (no campaign
  automation this phase, per the brief). The real governor that *does*
  apply in full — daily limit, minimum gap, jitter, per-mailbox/instance/
  gateway — is unaffected and tested. A future phase that wants outreach
  windows for agent messages should add a workspace- or agent-level default
  window, not force a synthetic campaign onto every proposal.
- **No campaign-launch automation.** `propose_send` accepts an optional
  `campaignId` purely for tagging the resulting `Message` — it does not
  create `CampaignStep`s, run `buildQueue`, or interact with campaign
  status. Constrained deliberately, per the brief.
- **No Command Center, no natural-language routing, no autonomous
  execution without a human or a policy in the loop** — all explicitly out
  of scope for this phase.
