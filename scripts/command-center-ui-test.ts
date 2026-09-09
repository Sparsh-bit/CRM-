/**
 * Regression test for the ONE piece of real branching logic the new
 * Command Center UI owns itself (src/app/workforce/command-center/_lib/
 * status.ts) — everything else in that page is either a direct pass-through
 * to the real backend contracts (already covered by scripts/command-center-
 * test.ts) or plain rendering. No live DB needed: these are pure functions.
 * Run via `npm run command-center-ui:test`.
 */
import { deriveOverallStatus, buildStepViewModels } from '../src/app/workforce/command-center/_lib/status';
import type { ResolvedPlanStep } from '../src/lib/agents/planner';

let fails = 0;
function check(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { fails++; console.log(`FAIL ${name}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`); }
  else console.log(`pass ${name}`);
}

// ── deriveOverallStatus ──────────────────────────────────────────────────
check(
  'a step sitting at WaitingForApproval wins over the root still saying Working',
  deriveOverallStatus({ status: 'Working', output: null }, [{ status: 'Completed' }, { status: 'WaitingForApproval' }]),
  'waiting_approval',
);
check('a plain Working root with no waiting step is just working', deriveOverallStatus({ status: 'Working', output: null }, [{ status: 'Completed' }]), 'working');
check('Queued root reads as queued', deriveOverallStatus({ status: 'Queued', output: null }, []), 'queued');
check('Cancelled root reads as cancelled', deriveOverallStatus({ status: 'Cancelled', output: null }, []), 'cancelled');
check('Failed root reads as failed (planner failure — no CommandResult at all)', deriveOverallStatus({ status: 'Failed', output: null }, []), 'failed');
check(
  'a Completed root whose CommandResult says partial reads as partial, never a plain completed',
  deriveOverallStatus({ status: 'Completed', output: { status: 'partial' } }, []),
  'partial',
);
check(
  'a Completed root whose CommandResult says cancelled (every step cancelled) reads as cancelled',
  deriveOverallStatus({ status: 'Completed', output: { status: 'cancelled' } }, []),
  'cancelled',
);
check('a genuinely fully-successful Completed root reads as completed', deriveOverallStatus({ status: 'Completed', output: { status: 'completed' } }, []), 'completed');
check('an unrecognized root status is reported as unknown, never guessed', deriveOverallStatus({ status: 'SomethingNew', output: null }, []), 'unknown');

// ── buildStepViewModels ──────────────────────────────────────────────────
const planSteps: ResolvedPlanStep[] = [
  { index: 0, agentId: 'a1', agentName: 'Research Bot', agentRole: 'Research', task: 'look up the lead', toolCalls: [{ tool: 'get_lead', args: {} }], droppedToolCalls: [], dependencies: [] },
  { index: 1, agentId: 'a2', agentName: 'Outreach Bot', agentRole: 'Outreach', task: 'propose an email', toolCalls: [{ tool: 'propose_send', args: {} }], droppedToolCalls: [], dependencies: [0] },
];
const taskRows = [
  { id: 't1', status: 'Completed', description: 'look up the lead', output: { ok: true }, failureReason: null },
  { id: 't2', status: 'WaitingForApproval', description: 'propose an email', output: null, failureReason: null },
];
const vms = buildStepViewModels(planSteps, taskRows);
check('step view models zip by creation-order position, one per real task row', vms.length, 2);
check('agent name/role come from the resolved plan, not invented', [vms[0].agentName, vms[0].agentRole], ['Research Bot', 'Research']);
check('real task status is used verbatim, never the plan\'s', vms[1].status, 'WaitingForApproval');
check('dependency positions come from the plan, for display only', vms[1].dependsOnPositions, [0]);
check('only a propose_send tool call is flagged as possibly needing approval', [vms[0].mayRequireApproval, vms[1].mayRequireApproval], [false, true]);

const vmsNoPlan = buildStepViewModels(undefined, taskRows);
check('with no plan available, agent name/role fall back to an honest placeholder, never a guess', [vmsNoPlan[0].agentName, vmsNoPlan[0].agentRole], ['—', '—']);
check('with no plan available, the task text still comes from the real task row', vmsNoPlan[0].taskText, 'look up the lead');

console.log(fails ? `\n${fails} FAILED` : '\nall command center UI logic tests passed');
process.exit(fails ? 1 : 0);
