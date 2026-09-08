import { decodeErrorDisplay } from '@/lib/errors/display';

/**
 * Renders a provider `lastError` value the way section 4/6 of the UX phase
 * asks for: a human-readable line up front, raw technical detail tucked
 * behind an expandable disclosure — never a wall of stack trace by default.
 * Handles both the new JSON-encoded {message, detail} shape and every
 * pre-existing plain-string lastError already in the database.
 */
export function ErrorDetail({ raw }: { raw: string | null | undefined }) {
  const err = decodeErrorDisplay(raw);
  if (!err) return null;
  return (
    <div className="text-xs text-bad break-words">
      <div>{err.message}</div>
      {err.detail && (
        <details className="mt-1">
          <summary className="cursor-pointer text-muted hover:text-slate-300">Technical details</summary>
          <pre className="mt-1 whitespace-pre-wrap break-all text-[11px] text-muted bg-ink rounded-md p-2 border border-line">{err.detail}</pre>
        </details>
      )}
    </div>
  );
}
