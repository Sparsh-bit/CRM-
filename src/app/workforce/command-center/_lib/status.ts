/**
 * Command Center's own status vocabulary. A "Command" isn't a database enum
 * (see src/lib/agents/commandCenter.ts's file comment — it's a root AgentTask
 * plus its CommandResult), so its user-facing status is derived from real
 * fields on that task, never a separate stored flag:
 *  - a step actually sitting at TaskStatus.WaitingForApproval is the ONLY
 *    signal for "waiting for approval" — the root task itself never carries
 *    that status (see finalizeCommandIfDone: the root stays 'Working' the
 *    whole time one of its steps is non-terminal).
 *  - "partial" / a terminal "cancelled" both come from CommandResult.status
 *    (root.output), not from root.status alone — finalizeCommandIfDone sets
 *    root.status to 'Completed' even when the result is partial or every
 *    step was cancelled; only a genuinely failed plan sets root.status to
 *    'Failed'. Reproducing that distinction here, rather than only reading
 *    root.status, is what keeps "Partially completed" from silently reading
 *    as a plain "Completed".
 */
import type { Tone } from '@/lib/ui/tone';
import type { ResolvedPlanStep } from '@/lib/agents/planner';

export type OverallStatus =
  | 'queued' | 'working' | 'waiting_approval'
  | 'completed' | 'partial' | 'failed' | 'cancelled' | 'unknown';

export const OVERALL_STATUS_META: Record<OverallStatus, { label: string; tone: Tone }> = {
  queued: { label: 'Queued', tone: 'muted' },
  working: { label: 'Working', tone: 'accent' },
  waiting_approval: { label: 'Waiting for approval', tone: 'warn' },
  completed: { label: 'Completed', tone: 'good' },
  partial: { label: 'Partially completed', tone: 'warn' },
  failed: { label: 'Failed', tone: 'bad' },
  cancelled: { label: 'Cancelled', tone: 'muted' },
  unknown: { label: 'Unknown', tone: 'muted' },
};

export function deriveOverallStatus(
  root: { status: string; output: unknown },
  steps: { status: string }[],
): OverallStatus {
  if (steps.some((s) => s.status === 'WaitingForApproval')) return 'waiting_approval';
  if (root.status === 'Working') return 'working';
  if (root.status === 'Queued') return 'queued';
  if (root.status === 'Cancelled') return 'cancelled';
  if (root.status === 'Failed') return 'failed';
  if (root.status === 'Completed') {
    const result = root.output as { status?: string } | null;
    if (result?.status === 'partial') return 'partial';
    if (result?.status === 'cancelled') return 'cancelled';
    if (result?.status === 'failed') return 'failed'; // defensive: shouldn't happen (finalizeCommandIfDone would have set root Failed itself), never trust root.status blindly
    return 'completed';
  }
  return 'unknown'; // an unrecognized TaskStatus value — never guess, say so
}

export type StepViewModel = {
  /** Position in creation order. See buildStepViewModels for why this doubles as the plan index. */
  position: number;
  taskId: string;
  agentName: string;
  agentRole: string;
  taskText: string;
  status: string;
  output: unknown;
  failureReason: string | null;
  /** Plan-step positions this step waits on, for display only — the real dependency edges live in the task's own relatedRecordIds. */
  dependsOnPositions: number[];
  mayRequireApproval: boolean;
};

/**
 * Zips each real step task (from getCommand/executeCommand, ordered by
 * createdAt asc) with its planner-resolved counterpart (ResolvedPlan.steps,
 * same order) purely for display labels (agent name/role, dependency
 * positions) that the task row alone doesn't carry.
 *
 * ponytail: matched by creation-order position, not an explicit id link —
 * safe here because commandCenter.ts's executeCommand() creates step tasks
 * in exactly this order and getCommand() orders by createdAt asc. Every
 * status/output/failureReason value still comes straight from the real task
 * row, never the plan — a mismatch here could only mislabel which agent a
 * step displays as, never fabricate what actually happened.
 */
export function buildStepViewModels(
  planSteps: ResolvedPlanStep[] | undefined,
  taskRows: { id: string; status: string; description: string | null; output: unknown; failureReason: string | null }[],
): StepViewModel[] {
  return taskRows.map((t, position) => {
    const p = planSteps?.[position];
    return {
      position,
      taskId: t.id,
      agentName: p?.agentName ?? '—',
      agentRole: p?.agentRole ?? '—',
      taskText: t.description ?? p?.task ?? '',
      status: t.status,
      output: t.output,
      failureReason: t.failureReason,
      dependsOnPositions: p?.dependencies ?? [],
      mayRequireApproval: p?.toolCalls.some((c) => c.tool === 'propose_send') ?? false,
    };
  });
}
