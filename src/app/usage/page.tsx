import { redirect } from 'next/navigation';
import { getSession } from '@/lib/session';
import { getUsageSummary } from '@/lib/usage/service';

export const dynamic = 'force-dynamic';

const LABELS: Record<string, string> = {
  ai_request: 'AI requests', ai_tokens: 'AI tokens', agent_task: 'Agent tasks',
  research_task: 'Research tasks', media_analysis: 'Media analyses', message: 'Messages sent',
  lead_processed: 'Leads imported', agents: 'AI employees', storage_bytes: 'Storage used',
};

function formatValue(kind: string, n: number): string {
  if (kind === 'storage_bytes') return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return n.toLocaleString();
}

function Bar({ used, limit }: { used: number; limit: number | null }) {
  if (limit === null) return <div className="text-xs text-muted">Unlimited</div>;
  const pct = Math.min(100, Math.round((used / limit) * 100));
  const tone = pct >= 100 ? 'bg-bad' : pct >= 80 ? 'bg-warn' : 'bg-good';
  return (
    <div className="space-y-1">
      <div className="h-1.5 rounded-full bg-line overflow-hidden"><div className={`h-full ${tone}`} style={{ width: `${pct}%` }} /></div>
      <div className="text-xs text-muted">{pct}% of plan limit</div>
    </div>
  );
}

export default async function UsagePage() {
  const s = await getSession();
  if (!s) redirect('/login');
  const summary = await getUsageSummary(s.workspaceId);

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold">Usage</h1>
        <p className="text-sm text-muted mt-1">
          Plan: <span className="text-slate-200">{summary.plan}</span> · rolling {summary.periodDays}-day window for the counters below —
          not a payment integration yet, just real, workspace-scoped usage tracking.
        </p>
      </div>

      <div>
        <div className="font-medium mb-3">This period</div>
        <div className="grid md:grid-cols-3 gap-4">
          {Object.entries(summary.counters).map(([kind, v]) => v && (
            <div key={kind} className="card space-y-2">
              <div className="text-sm text-muted">{LABELS[kind] ?? kind}</div>
              <div className="text-xl font-semibold">{formatValue(kind, v.used)}{v.limit !== null && <span className="text-sm text-muted"> / {formatValue(kind, v.limit)}</span>}</div>
              <Bar used={v.used} limit={v.limit} />
            </div>
          ))}
        </div>
      </div>

      <div>
        <div className="font-medium mb-3">Right now</div>
        <div className="grid md:grid-cols-3 gap-4">
          {Object.entries(summary.gauges).map(([kind, v]) => v && (
            <div key={kind} className="card space-y-2">
              <div className="text-sm text-muted">{LABELS[kind] ?? kind}</div>
              <div className="text-xl font-semibold">{formatValue(kind, v.used)}{v.limit !== null && <span className="text-sm text-muted"> / {formatValue(kind, v.limit)}</span>}</div>
              <Bar used={v.used} limit={v.limit} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
