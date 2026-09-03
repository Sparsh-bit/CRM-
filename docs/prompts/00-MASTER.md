# 00 — Master agent brief

Give this file to the coding agent first. Everything else in `docs/prompts/` is
loaded on demand by the prompts inside it.

---

## Skill invocation protocol — read this before anything else

Every task in this pack runs through three skills. This is not optional
decoration; it is the working method.

| Skill | When it fires | What it must produce |
|---|---|---|
| **superpowers** | Before writing a single line of any task | A design proposal (brainstorm → plan → RED/GREEN/REFACTOR TDD → code review). Never code first. |
| **ponytail** | While building | Every change tied back to the user-visible behaviour it serves; no orphan abstractions, no speculative layers, no dead code left behind. |
| **get shit done** | At the end of every task | The task is *shipped*: it runs, it is tested, it is committed, and the next task is unblocked. No "I'll wire that up later." |

**At the start of every task, state out loud:**

```
SKILLS: superpowers (design + TDD) · ponytail (keep it tied to real behaviour) · get shit done (ship it)
TASK:   <task id and name>
DONE WHEN: <the observable thing that will be true>
```

**If a skill is not installed in your environment, do not silently skip it.**
Say which one is missing and apply its discipline manually:

- *superpowers missing* → still brainstorm, still plan, still write the failing
  test before the implementation, still self-review the diff.
- *ponytail missing* → still delete every abstraction that no user-visible
  behaviour needs.
- *get shit done missing* → still refuse to mark a task complete until it runs,
  passes its tests, and is committed.

---

## Who you are

You are building **OutreachPilot**: a multi-tenant bulk outreach platform for
email and WhatsApp, aimed at small sales teams and agencies who currently work
out of a spreadsheet. Its two differentiators are:

1. **The spreadsheet just works.** A user drops in any lead file — any number of
   sheets, any column names, title banners above the headers — and it is read,
   mapped, and imported without a mapping wizard interrogating them.
2. **AI that writes per lead, not per campaign.** The writer reads *every*
   column of *that lead's row* — including the ones nobody bothered to map — and
   writes a message about that specific business. The user supplies a purpose;
   the system supplies the personalisation.

## Non-negotiable product rules

1. **Nothing sends without passing preflight.** Unresolved merge tags, missing
   addresses, suppressed contacts, and ungenerated AI drafts are hard blocks.
   "Hi ," reaching 68 CEOs is the failure mode this product exists to prevent.
2. **The AI never invents a fact about a lead.** If the sheet does not say it,
   the email does not claim it. Low-confidence drafts are flagged for human review.
3. **Unsubscribe is instant, honoured across every channel, and one click.**
   `List-Unsubscribe` + `List-Unsubscribe-Post` on every email.
4. **Per-mailbox caps, warmup ramps and throttling are enforced in one place**
   (`src/lib/scheduler.ts`) and cannot be bypassed by any send path.
5. **Secrets are encrypted at rest.** SMTP passwords, API keys and OAuth tokens
   never appear in the database in plaintext.
6. **Every tenant is isolated by `workspaceId`.** Every query filters on it.
   A missing filter is a security bug, not a style issue.
7. **The worker is idempotent.** It can be killed and restarted mid-campaign
   without double-sending. Uniqueness is enforced at the database level.

## Definition of done for the whole product

- A user signs up, connects a mailbox, uploads `samples/Outreach_Kit_Tier13.xlsx`,
  creates an AI campaign with a one-paragraph purpose, reviews 68 generated
  drafts, launches, and watches sends, opens, clicks and replies land in the
  dashboard — without editing a config file or reading the source.
- `npm run typecheck` is clean. `npm test` is green. `npm run build` succeeds.
- A cold-start deploy works from `README.md` alone.

## Order of work

Tasks in `03-BUILD-PROMPTS.md` are numbered in dependency order. Do not start a
task whose dependencies are not shipped. After each task, run the full test
suite and commit — that is `get shit done` doing its job.
