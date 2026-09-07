# Onboarding (Phase 10)

## Real status, not a saved flag

`src/lib/onboarding/status.ts`'s `getOnboardingStatus(workspaceId)` computes
every step live from the database (and, for the AI-configuration step, from
environment) — there is no `Workspace.onboardingComplete` boolean anywhere.
A step cannot silently read "complete" while the thing it describes is
actually broken (Section 2: "do not mark a setup step complete unless it is
actually complete").

| Step | Real check |
|---|---|
| Workspace setup | Always `connected` — the workspace row exists by the time onboarding renders |
| Profile / company info | `configured` once `Workspace.senderName` and `senderCompany` are both non-empty |
| Connect Email | `connected` if any `Mailbox.status === 'active'`; `error` if any is `'error'`; `needs_attention` if one exists but isn't active; else `not_configured` |
| Connect WhatsApp | Same pattern over `WaInstance.status` |
| Connect SMS | Same pattern over `SmsGateway.status` |
| AI configuration | `configured` if `GROQ_API_KEY`/`ANTHROPIC_API_KEY`/`OPENAI_API_KEY` is set on this deployment (env-derived, not per-workspace — there is no per-workspace AI key in this build) |
| Create AI employees | `connected` once `Agent` count > 0 |
| Optional sample task (optional) | `connected` once any `AgentTask` exists |
| Completion | Always available — Workforce is one click away regardless of setup progress |

`complete` (the overall flag returned alongside `steps`) is true once every
**non-optional** step is at least `configured`/`connected` — an `error` step
still blocks it.

## Built-in employees (Section 3)

`/onboarding`'s "Create AI employees" form uses the existing template
architecture (`AGENT_TEMPLATES`, `src/lib/agents/templates.ts`) and the
existing `createAgent()` — no second agent system, no duplicated
role/tool/autonomy logic. Selecting a template creates it with **exactly**
that template's own `allowedTools` and `autonomyLevel` — onboarding never
upgrades autonomy. Every non-Outreach template defaults to `SuggestOnly`;
Outreach defaults to `DraftAndRequestApproval`, which still creates a real,
human-decided `Approval` for every send (Phase 6/8) — autonomous messaging
is never silently enabled by onboarding (Section 3's explicit requirement).

Full customization — objective, instructions, tool review, autonomy change
— is one link away at `/workforce/agents` (frontend-owned), which already
has its own create/edit flow from Phase 4 onward. Onboarding does not
duplicate that UI; it only offers the fast "use the built-in defaults" path.

## Communication setup (Section 4)

`/mailboxes`, `/whatsapp` already existed (Phase 1/3). **`/sms` is new this
phase** — the one channel that had a fully-built service layer
(`src/lib/sms/gateways.ts`, Phase 5) but no page yet; that file's own header
comment said as much ("the service layer a future /sms settings page wires
up to"). All three pages call only the existing
`EmailService`/`WhatsAppService`(`evolution.ts`)/`SmsService`(`sms/index.ts`)
— no duplicate provider system. None of the three ever renders a decrypted
credential back to the browser; `checkGatewayConnection`/`connectionState`
are the only "is this real" signal, never a claimed status without one.

## Optional sample task (Section 2.8)

Runs a real `summarize_lead` task (read-only) on the workspace's most
recently imported lead, through the actual `createTask` -> Job ->
`executeAgentTask` pipeline — not a canned demo response. Requires both a
real `Research` agent and a real lead to exist; if either is missing, the
page says so and does nothing rather than fabricating a placeholder result.

## New signups land here

`src/app/login/page.tsx`'s new-account path now redirects to `/onboarding`
instead of `/settings` — `/settings` is one click away in the "Profile /
company info" step, and from the nav at all times.
