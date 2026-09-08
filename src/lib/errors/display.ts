/**
 * How a provider-connection error is stored in a `lastError` column and
 * shown back in the UI: one human-readable line plus an optional expandable
 * technical detail (the real status code / raw response, never a secret).
 * Stored as a JSON string inside the existing `lastError String? @db.Text`
 * column on Mailbox/WaInstance/SmsGateway — no schema change. Reading a
 * plain pre-existing string (every row written before this) still works:
 * decode() falls back to treating it as the human message with no detail.
 */
export type ErrorDisplay = { message: string; detail: string };

export function encodeErrorDisplay(d: ErrorDisplay): string {
  return JSON.stringify(d);
}

export function decodeErrorDisplay(raw: string | null | undefined): ErrorDisplay | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && typeof (parsed as { message?: unknown }).message === 'string') {
      const p = parsed as { message: string; detail?: unknown };
      return { message: p.message, detail: typeof p.detail === 'string' ? p.detail : '' };
    }
  } catch {
    /* not JSON — a legacy plain-string lastError, fall through to the split below */
  }
  return splitEmbeddedTechnicalTail(raw);
}

/**
 * A plain-string lastError written before this display split existed (or by
 * a provider whose own error classifier embeds the raw response in its
 * message, e.g. httpSMS's "httpSMS 401 on /v1/phones: {...}") often has a
 * real JSON/text tail glued onto an otherwise-human prefix with ": ". Split
 * it the same way encodeErrorDisplay's structured form would — the source
 * module's own classification (kind/retryable/etc.) is untouched; only how
 * the same string renders changes.
 */
function splitEmbeddedTechnicalTail(raw: string): ErrorDisplay {
  const match = raw.match(/^(.*?):\s*(\{.*\}|\[.*\])\s*$/s);
  if (match) return { message: match[1].trim(), detail: match[2].trim() };
  return { message: raw, detail: '' };
}
