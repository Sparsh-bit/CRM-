'use client';

import { Card } from '@/components/Card';
import { Badge } from '@/components/Badge';
import { Button } from '@/components/Button';
import type { ResolvedPlan } from '@/lib/agents/planner';

/**
 * Section 4: what previewCommand() actually returned, before anything is
 * created — every field below is read straight off the real ResolvedPlan,
 * nothing here is invented ahead of execution. "Needs approval" is the one
 * inference this view makes, and it's a fact about the system (only
 * propose_send ever creates an Approval — see _lib/status.ts's
 * mayRequireApproval), not a guess about what will happen.
 */
export function PlanPreview({
  plan, onRun, onDiscard, isRunning,
}: { plan: ResolvedPlan; onRun: () => void; onDiscard: () => void; isRunning: boolean }) {
  return (
    <Card className="space-y-4">
      <div>
        <div className="text-meta">Your request</div>
        <p className="card-heading mt-0.5">{plan.goal}</p>
      </div>

      <div className="space-y-2">
        <div className="text-meta">Plan</div>
        {plan.steps.map((s) => (
          <div key={s.index} className="rounded-lg border border-line p-3 space-y-1.5">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <span className="text-sm font-medium text-slate-100">
                {s.agentName} <span className="text-secondary font-normal">· {s.agentRole}</span>
              </span>
              {s.toolCalls.some((c) => c.tool === 'propose_send') && <Badge label="Needs approval" tone="warn" />}
            </div>
            <p className="text-secondary">→ {s.task}</p>
            {s.dependencies.length > 0 && (
              <p className="text-meta">Waits for step {s.dependencies.map((d) => d + 1).join(', ')}</p>
            )}
            {s.toolCalls.length > 0 && (
              <div className="flex flex-wrap gap-1.5 pt-0.5">
                {s.toolCalls.map((c, i) => <Badge key={i} label={c.tool} tone="muted" />)}
              </div>
            )}
            {s.droppedToolCalls.length > 0 && (
              <p className="text-meta text-bad">Not usable: {s.droppedToolCalls.map((d) => `${d.tool} (${d.reason})`).join('; ')}</p>
            )}
          </div>
        ))}
        {!plan.steps.length && <p className="text-secondary">No steps could be planned from this request.</p>}
      </div>

      {plan.rejectedSteps.length > 0 && (
        <div className="space-y-1 border-t border-line pt-3">
          <div className="text-meta">No suitable employee</div>
          {plan.rejectedSteps.map((r) => (
            <p key={r.index} className="text-secondary">{r.reason}</p>
          ))}
        </div>
      )}
      {plan.unsupported && <p className="text-secondary border-t border-line pt-3">{plan.unsupported}</p>}

      <div className="flex gap-2 border-t border-line pt-3">
        <Button type="button" onClick={onRun} disabled={isRunning || plan.steps.length === 0}>
          {isRunning ? 'Running…' : 'Run plan'}
        </Button>
        <Button type="button" variant="secondary" onClick={onDiscard} disabled={isRunning}>Cancel</Button>
      </div>
    </Card>
  );
}
