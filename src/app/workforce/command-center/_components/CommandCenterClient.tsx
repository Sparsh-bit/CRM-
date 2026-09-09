'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import Link from 'next/link';
import { Card } from '@/components/Card';
import { Badge } from '@/components/Badge';
import { Button } from '@/components/Button';
import { ErrorDetail } from '@/components/ErrorDetail';
import type { ResolvedPlan } from '@/lib/agents/planner';
import type { CommandResult } from '@/lib/agents/commandCenter';
import { OVERALL_STATUS_META, deriveOverallStatus } from '../_lib/status';
import {
  previewCommandAction, executeCommandAction, refreshCommandAction, listCommandsAction,
  type CommandSnapshot, type CommandHistoryRow,
} from '../actions';
import { PlanPreview } from './PlanPreview';
import { CommandRun } from './CommandRun';

const EXAMPLE_COMMANDS = [
  'Find my highest priority leads.',
  'Analyze our campaign performance.',
  'Prepare follow-ups for leads who replied positively.',
  'Research these companies.',
];

/** Root-task statuses nothing further will ever change on its own — matches commandCenter.ts's own TERMINAL_STATUSES. Stop polling once here (Section 17). */
const TERMINAL_ROOT_STATUSES = new Set(['Completed', 'Failed', 'Cancelled']);
const POLL_MS = 3000;

export function CommandCenterClient({
  initialHistory, initialHistoryError, hasAgents,
}: { initialHistory: CommandHistoryRow[]; initialHistoryError: string | null; hasAgents: boolean }) {
  const [commandText, setCommandText] = useState('');
  const [validationMessage, setValidationMessage] = useState<string | null>(null);

  const [plan, setPlan] = useState<ResolvedPlan | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [isPreviewPending, startPreview] = useTransition();

  const [active, setActive] = useState<CommandSnapshot | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [isExecutePending, startExecute] = useTransition();

  const [history, setHistory] = useState(initialHistory);
  const [historyError, setHistoryError] = useState(initialHistoryError);
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [isOpenPending, startOpen] = useTransition();

  async function refreshHistory() {
    const res = await listCommandsAction();
    if (res.ok) { setHistory(res.data); setHistoryError(null); }
    else setHistoryError(res.error);
  }

  function handlePreview() {
    const text = commandText.trim();
    if (!text) { setValidationMessage('Type a command first.'); return; }
    setValidationMessage(null);
    setPreviewError(null);
    startPreview(async () => {
      const res = await previewCommandAction(text);
      if (res.ok) setPlan(res.data);
      else setPreviewError(res.error);
    });
  }

  function discardPlan() {
    setPlan(null);
    setPreviewError(null);
  }

  function handleRun() {
    const text = commandText.trim();
    if (!text) return;
    setRunError(null);
    startExecute(async () => {
      const res = await executeCommandAction(text);
      if (res.ok) {
        setActive(res.data);
        setPlan(null);
        setCommandText('');
        void refreshHistory();
      } else {
        setRunError(res.error);
      }
    });
  }

  function openHistoryItem(id: string) {
    setOpeningId(id);
    startOpen(async () => {
      const res = await refreshCommandAction(id);
      if (res.ok) { setActive(res.data); setHistoryError(null); }
      else setHistoryError(res.error);
      setOpeningId(null);
    });
  }

  // Section 17: poll only while the active command's root is genuinely
  // non-terminal, at a fixed unhurried interval, and stop outright once it
  // resolves — no WebSocket, no aggressive interval, no polling a finished command.
  const activeId = active?.root.id;
  const activeStatus = active?.root.status;
  const wasTerminal = useRef(true);
  useEffect(() => {
    if (!activeId || !activeStatus) return;
    if (TERMINAL_ROOT_STATUSES.has(activeStatus)) {
      if (!wasTerminal.current) void refreshHistory(); // just settled — refresh the history row's own status/result too
      wasTerminal.current = true;
      return;
    }
    wasTerminal.current = false;
    const id = setInterval(async () => {
      const res = await refreshCommandAction(activeId);
      if (res.ok) setActive(res.data);
    }, POLL_MS);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, activeStatus]);

  return (
    <div className="space-y-6">
      <Card className="space-y-3">
        <div>
          <label className="label" htmlFor="command-input">What do you need?</label>
          <textarea
            id="command-input"
            className="input h-24 resize-none"
            maxLength={2000}
            value={commandText}
            onChange={(e) => { setCommandText(e.target.value); if (validationMessage) setValidationMessage(null); }}
            placeholder="e.g. Find my highest priority leads."
            disabled={isPreviewPending || isExecutePending}
            aria-invalid={!!validationMessage}
            aria-describedby={validationMessage ? 'command-input-error' : undefined}
          />
        </div>
        {validationMessage && <p id="command-input-error" role="alert" className="text-bad text-xs">{validationMessage}</p>}
        {previewError && <ErrorDetail raw={previewError} />}
        {!hasAgents && (
          <p className="text-secondary">
            You don&apos;t have any AI employees yet — a command needs at least one to do anything.{' '}
            <Link href="/workforce/agents" className="text-accent hover:underline">Create your first employee →</Link>
          </p>
        )}
        <div className="flex flex-wrap gap-1.5">
          {EXAMPLE_COMMANDS.map((ex) => (
            <button
              key={ex} type="button" onClick={() => { setCommandText(ex); setValidationMessage(null); }}
              className="text-xs rounded-full border border-line px-2.5 py-1 text-muted hover:text-slate-200 hover:border-accent/50 transition-colors"
            >
              {ex}
            </button>
          ))}
        </div>
        <div className="flex justify-end">
          <Button type="button" onClick={handlePreview} disabled={isPreviewPending}>
            {isPreviewPending ? 'Planning…' : 'Preview plan'}
          </Button>
        </div>
      </Card>

      {plan && (
        <>
          {runError && <ErrorDetail raw={runError} />}
          <PlanPreview plan={plan} onRun={handleRun} onDiscard={discardPlan} isRunning={isExecutePending} />
        </>
      )}

      {!plan && active && <CommandRun snapshot={active} onChange={setActive} />}

      <div className="space-y-2">
        <div className="text-meta">Recent commands</div>
        {historyError && <ErrorDetail raw={historyError} />}
        {history.length ? (
          <Card className="p-0 overflow-hidden overflow-x-auto">
            <table className="w-full">
              <thead className="bg-ink">
                <tr>{['Command', 'Status', 'Agents', 'Created by', 'Started / finished', 'Result'].map((h) => <th key={h} className="th">{h}</th>)}</tr>
              </thead>
              <tbody>
                {history.map((h) => {
                  const result = h.output as CommandResult | null;
                  const overall = deriveOverallStatus({ status: h.status, output: h.output }, []);
                  const finished = TERMINAL_ROOT_STATUSES.has(h.status);
                  return (
                    <tr key={h.id}>
                      <td className="td max-w-xs">
                        <button
                          type="button" onClick={() => openHistoryItem(h.id)} disabled={isOpenPending && openingId === h.id}
                          className="text-accent hover:underline text-left disabled:opacity-50"
                        >
                          {openingId === h.id && isOpenPending ? 'Opening…' : (h.requested || '(no text)')}
                        </button>
                      </td>
                      <td className="td"><Badge {...OVERALL_STATUS_META[overall]} /></td>
                      <td className="td text-muted">{result?.agentsInvolved.length ? result.agentsInvolved.map((a) => a.agentName).join(', ') : '—'}</td>
                      <td className="td text-muted">{h.createdByEmail}</td>
                      <td className="td text-muted">
                        {new Date(h.createdAt).toLocaleString()}
                        {finished && <div>→ {new Date(h.updatedAt).toLocaleString()}</div>}
                      </td>
                      <td className="td text-muted">{result ? `${result.tasksCompleted}/${result.tasksTotal} completed` : '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Card>
        ) : (
          <Card className="text-center py-12 space-y-2">
            <p className="text-secondary">No commands yet — try one of the examples above, or type your own.</p>
          </Card>
        )}
      </div>
    </div>
  );
}
