'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { ArrowDown, ArrowSquareOut } from '@phosphor-icons/react';
import { Card } from '@/components/Card';
import { Badge } from '@/components/Badge';
import { Button } from '@/components/Button';
import { ErrorDetail } from '@/components/ErrorDetail';
import type { Tone } from '@/lib/ui/tone';
import { TASK_STATUS_META } from '@/app/workforce/_lib/status';
import type { ResolvedPlan, RejectedStep } from '@/lib/agents/planner';
import type { CommandResult } from '@/lib/agents/commandCenter';
import { OVERALL_STATUS_META, deriveOverallStatus, buildStepViewModels } from '../_lib/status';
import { cancelCommandAction, type CommandSnapshot } from '../actions';

/** A command can only ever be cancelled while it still has something in flight — reusing the exact same three non-terminal states the task graph itself can be in. */
const CANCELLABLE = new Set(['queued', 'working', 'waiting_approval']);

function taskBadge(status: string) {
  return (TASK_STATUS_META as Record<string, { label: string; tone: Tone }>)[status] ?? { label: status, tone: 'muted' as Tone };
}

/**
 * Section 5-9: the live (or reopened) view of one real command — status,
 * task graph with dependencies, results, an approval hand-off banner, and
 * cancellation. Every value rendered here comes from the CommandSnapshot the
 * server actions returned; nothing is computed from a second frontend task
 * model (see _lib/status.ts's buildStepViewModels doc comment).
 */
export function CommandRun({ snapshot, onChange }: { snapshot: CommandSnapshot; onChange: (next: CommandSnapshot) => void }) {
  const [isPending, startTransition] = useTransition();
  const [cancelError, setCancelError] = useState<string | null>(null);

  const plan = (snapshot.root.input as { plan?: ResolvedPlan } | null)?.plan;
  const overall = deriveOverallStatus(snapshot.root, snapshot.steps);
  const steps = buildStepViewModels(plan?.steps, snapshot.steps);
  const result = snapshot.root.output as CommandResult | null;
  const canCancel = CANCELLABLE.has(overall);

  function cancel() {
    setCancelError(null);
    startTransition(async () => {
      const res = await cancelCommandAction(snapshot.root.id);
      if (res.ok) onChange(res.data);
      else setCancelError(res.error);
    });
  }

  return (
    <Card className="space-y-5">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="min-w-0">
          <div className="text-meta">Command</div>
          <p className="text-sm text-slate-100 mt-0.5">{snapshot.root.description}</p>
          {plan?.goal && <p className="text-secondary mt-1">Goal: {plan.goal}</p>}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Badge {...OVERALL_STATUS_META[overall]} />
          {canCancel && (
            <Button type="button" variant="secondary" onClick={cancel} disabled={isPending}>
              {isPending ? 'Cancelling…' : 'Cancel command'}
            </Button>
          )}
        </div>
      </div>
      {cancelError && <ErrorDetail raw={cancelError} />}

      {overall === 'waiting_approval' && (
        <div className="rounded-lg border border-warn/30 bg-warn/10 p-3 flex items-center justify-between gap-3 flex-wrap">
          <p className="text-sm text-slate-100">One or more actions are waiting for your approval before anything sends.</p>
          <Link href="/workforce/approvals" className="btn-sec text-xs inline-flex items-center gap-1.5 shrink-0">
            Review approvals <ArrowSquareOut size={14} />
          </Link>
        </div>
      )}

      <div className="space-y-2">
        <div className="text-meta">Tasks</div>
        <div className="space-y-2">
          {steps.map((s) => (
            <div key={s.taskId}>
              {s.dependsOnPositions.length > 0 && (
                <div className="flex items-center gap-1.5 text-meta pl-4 py-1">
                  <ArrowDown size={12} /> waits for step {s.dependsOnPositions.map((i) => i + 1).join(', ')}
                </div>
              )}
              <div className="rounded-lg border border-line p-3 space-y-1.5">
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div className="min-w-0">
                    <span className="text-sm font-medium text-slate-100">{s.agentName}</span>
                    <span className="text-secondary"> · {s.agentRole}</span>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {s.mayRequireApproval && <Badge label="Needs approval" tone="warn" />}
                    <Badge {...taskBadge(s.status)} />
                  </div>
                </div>
                <p className="text-secondary">{s.taskText}</p>
                {s.failureReason && <p className="text-bad text-xs">{s.failureReason}</p>}
                {s.status === 'Completed' && s.output != null && (
                  <details>
                    <summary className="cursor-pointer text-xs text-muted hover:text-slate-300">Result</summary>
                    <pre className="mt-1 whitespace-pre-wrap break-all text-[11px] text-muted bg-ink rounded-md p-2 border border-line max-h-56 overflow-auto">
                      {JSON.stringify(s.output, null, 2)}
                    </pre>
                  </details>
                )}
              </div>
            </div>
          ))}
          {!steps.length && <p className="text-secondary">No tasks were created for this command.</p>}
        </div>
      </div>

      {plan?.rejectedSteps && plan.rejectedSteps.length > 0 && (
        <div className="space-y-1 border-t border-line pt-3">
          <div className="text-meta">Could not be scheduled</div>
          {plan.rejectedSteps.map((r: RejectedStep) => (
            <p key={r.index} className="text-secondary">{r.agentRole ? `${r.agentRole}: ` : ''}{r.reason}</p>
          ))}
        </div>
      )}
      {plan?.unsupported && <p className="text-secondary border-t border-line pt-3">{plan.unsupported}</p>}

      {result && (
        <div className="space-y-1.5 border-t border-line pt-3">
          <div className="text-meta">Summary</div>
          <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm text-secondary">
            <span>{result.tasksCompleted} completed</span>
            <span>{result.tasksFailed} failed</span>
            <span>{result.tasksCancelled} cancelled</span>
            <span>{result.approvalsRequested} approval{result.approvalsRequested === 1 ? '' : 's'} requested</span>
          </div>
          {result.recommendations.length > 0 && (
            <ul className="list-disc list-inside text-secondary space-y-0.5">
              {result.recommendations.map((r, i) => <li key={i}>{r}</li>)}
            </ul>
          )}
        </div>
      )}
      {!result && snapshot.root.failureReason && (
        <p className="text-bad text-xs border-t border-line pt-3">{snapshot.root.failureReason}</p>
      )}

      <div className="text-meta border-t border-line pt-3">
        Started {new Date(snapshot.root.createdAt).toLocaleString()} · Updated {new Date(snapshot.root.updatedAt).toLocaleString()}
      </div>
    </Card>
  );
}
