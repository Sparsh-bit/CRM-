import type { ReactNode } from 'react';
import { CopyField } from './CopyField';

export type Step = {
  title: string;
  description: ReactNode;
  note?: ReactNode;
  copy?: { value: string; label?: string };
};

/**
 * A numbered setup guide — plain server-rendered markup (no wizard state,
 * no client JS beyond the individual CopyField islands) so a guide is one
 * page a person can scan or link straight to a specific step. Progressive
 * disclosure comes from keeping each step's own text short, not from
 * hiding steps behind Next/Back — a reference doc a person re-visits mid
 * setup is worse off paginated.
 */
export function StepGuide({ steps }: { steps: Step[] }) {
  return (
    <ol className="space-y-4">
      {steps.map((step, i) => (
        <li key={i} className="card flex gap-4">
          <div className="shrink-0 w-7 h-7 rounded-full bg-accent/15 text-accent text-sm font-semibold flex items-center justify-center" aria-hidden>
            {i + 1}
          </div>
          <div className="space-y-2 min-w-0">
            <h3 className="font-medium">{step.title}</h3>
            <div className="text-sm text-muted">{step.description}</div>
            {step.copy && <CopyField value={step.copy.value} label={step.copy.label} />}
            {step.note && <p className="text-xs text-warn">{step.note}</p>}
          </div>
        </li>
      ))}
    </ol>
  );
}

/** A verified-source footer for provider-specific instructions — section 22's requirement made real, not a bare claim. */
export function VerifiedSource({ sources, verifiedOn }: { sources: { label: string; href: string }[]; verifiedOn: string }) {
  return (
    <p className="text-xs text-muted border-t border-line pt-4">
      Verified against official documentation on {verifiedOn}:{' '}
      {sources.map((s, i) => (
        <span key={s.href}>
          {i > 0 && ', '}
          <a className="text-accent" href={s.href}>{s.label}</a>
        </span>
      ))}
      . Not an official partnership or endorsement — third-party provider, independently documented here.
    </p>
  );
}
