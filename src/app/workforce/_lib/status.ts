/**
 * Human labels + pill tone for every enum value a Workforce page displays.
 * Centralized so a status reads identically everywhere (list, detail, overview)
 * and so an unhandled enum value fails loudly (via the exhaustiveness check in
 * the self-test below) instead of silently rendering blank.
 */
import { TaskStatus, ApprovalState, AutonomyLevel } from '@/generated/prisma/enums';
export { type Tone, pillClass } from '@/lib/ui/tone';
import type { Tone } from '@/lib/ui/tone';

/** "In motion" task states — shared by the main dashboard and the Workforce overview so "active tasks" means the same thing in both places. */
export const ACTIVE_TASK_STATUSES: TaskStatus[] = [
  TaskStatus.Queued, TaskStatus.Thinking, TaskStatus.Working,
  TaskStatus.WaitingForInput, TaskStatus.WaitingForApproval,
];

export const TASK_STATUS_META: Record<TaskStatus, { label: string; tone: Tone }> = {
  Queued: { label: 'Queued', tone: 'muted' },
  Thinking: { label: 'Thinking', tone: 'accent' },
  Working: { label: 'Working', tone: 'accent' },
  WaitingForInput: { label: 'Waiting for input', tone: 'warn' },
  WaitingForApproval: { label: 'Needs approval', tone: 'warn' },
  Completed: { label: 'Completed', tone: 'good' },
  Failed: { label: 'Failed', tone: 'bad' },
  Cancelled: { label: 'Cancelled', tone: 'muted' },
};

export const APPROVAL_STATE_META: Record<ApprovalState, { label: string; tone: Tone }> = {
  None: { label: '—', tone: 'muted' },
  Pending: { label: 'Pending', tone: 'warn' },
  Approved: { label: 'Approved', tone: 'good' },
  Rejected: { label: 'Rejected', tone: 'bad' },
};

export const AUTONOMY_META: Record<AutonomyLevel, { label: string; tone: Tone }> = {
  SuggestOnly: { label: 'Suggest only', tone: 'muted' },
  DraftAndRequestApproval: { label: 'Drafts, needs approval', tone: 'accent' },
  ExecuteApprovedActions: { label: 'Executes approved actions', tone: 'accent' },
  Autonomous: { label: 'Autonomous', tone: 'warn' },
};

export const AGENT_STATUS_META: Record<string, { label: string; tone: Tone }> = {
  active: { label: 'Active', tone: 'good' },
  paused: { label: 'Paused', tone: 'warn' },
  archived: { label: 'Archived', tone: 'muted' },
};

export function agentStatusMeta(status: string) {
  return AGENT_STATUS_META[status] ?? { label: status, tone: 'muted' as Tone };
}
