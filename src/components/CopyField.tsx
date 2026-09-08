'use client';

import { useState } from 'react';

/** A monospace value with a copy button — for endpoint paths, header names, placeholder tokens. Never used for a real secret. */
export function CopyField({ value, label }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard API unavailable (older browser, insecure context) — the
      // value is still visible and selectable by hand, so this is a
      // degraded experience, not a broken one.
    }
  }

  return (
    <div className="flex items-center gap-2">
      {label && <span className="text-xs text-muted">{label}</span>}
      <code className="text-xs bg-ink border border-line rounded px-2 py-1 text-slate-300 break-all">{value}</code>
      <button
        type="button"
        onClick={copy}
        className="text-xs text-accent hover:opacity-80 shrink-0"
        aria-label={`Copy ${label ?? value}`}
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}
