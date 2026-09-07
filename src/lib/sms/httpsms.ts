/**
 * httpSMS API client (https://github.com/NdoleStudio/httpsms — turns the
 * customer's own Android phone/SIM into an SMS gateway). Implemented against
 * the real, documented contract, verified against the official Node client
 * source (github.com/NdoleStudio/httpsms-node) and the server's own route
 * definitions (github.com/NdoleStudio/httpsms, api/pkg/handlers) — not
 * guessed.
 *
 * Base URL and auth: https://api.httpsms.com, header `x-api-key: <key>`.
 * Endpoints used:
 *   POST /v1/messages/send  — queue an SMS for the phone to send
 *   GET  /v1/phones         — list phones registered on this account
 *
 * httpSMS's public API does not expose a live "is this phone online right
 * now" field on /v1/phones (that's tracked server-side via heartbeat
 * events, not returned here) — see testConnection() in ./index.ts for
 * exactly what this integration can and cannot honestly claim.
 */

const BASE_URL = () => (process.env.HTTPSMS_BASE_URL || 'https://api.httpsms.com').replace(/\/+$/, '');
const TIMEOUT_MS = () => Number(process.env.HTTPSMS_TIMEOUT_MS ?? 15_000);

export type HttpSmsErrorKind = 'invalid_credentials' | 'invalid_request' | 'rate_limited' | 'provider_error' | 'network' | 'timeout';

export class HttpSmsError extends Error {
  constructor(message: string, public readonly kind: HttpSmsErrorKind, public readonly retryable: boolean) {
    super(message);
  }
}

async function call<T>(apiKey: string, path: string, init: RequestInit = {}): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS());
  let res: Response;
  try {
    res = await fetch(`${BASE_URL()}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'x-api-key': apiKey,
        ...(init.headers ?? {}),
      },
    });
  } catch (e) {
    clearTimeout(timer);
    if (controller.signal.aborted) throw new HttpSmsError(`httpSMS request to ${path} timed out after ${TIMEOUT_MS()}ms`, 'timeout', true);
    throw new HttpSmsError(`httpSMS network error: ${e instanceof Error ? e.message : String(e)}`, 'network', true);
  }
  clearTimeout(timer);

  const text = await res.text();
  if (!res.ok) {
    const kind: HttpSmsErrorKind =
      res.status === 401 ? 'invalid_credentials' :
      res.status === 429 ? 'rate_limited' :
      res.status >= 500 ? 'provider_error' : 'invalid_request';
    // 429/5xx are worth a caller retrying later; a 4xx like a bad key or a
    // malformed request is not — the same classification as ai/provider.ts.
    const retryable = kind === 'rate_limited' || kind === 'provider_error';
    throw new HttpSmsError(`httpSMS ${res.status} on ${path}: ${text.slice(0, 400)}`, kind, retryable);
  }
  return (text ? JSON.parse(text) : {}) as T;
}

/** Mirrors the real httpSMS Message entity — only the fields this app actually uses. */
export type HttpSmsMessage = {
  id: string;
  status: string; // e.g. "pending" — queued for the phone, NOT delivery confirmation
  content: string;
  contact: string;
  owner: string;
  request_id: string | null;
  sent_at: string | null;
  delivered_at: string | null;
  failed_at: string | null;
  failure_reason: string | null;
};

export type SendMessageArgs = {
  from: string;
  to: string;
  content: string;
  /** Client-tracking id httpSMS accepts for its own dedupe — we pass Message.trackingId, which already exists uniquely per Message row. */
  requestId?: string;
};

/**
 * Queues one SMS with the customer's phone via POST /v1/messages/send.
 * A resolved promise means httpSMS accepted the request for queueing —
 * NOT that the phone has sent it, and NOT that the carrier delivered it.
 */
export async function sendMessage(apiKey: string, args: SendMessageArgs): Promise<HttpSmsMessage> {
  const body = await call<{ data: HttpSmsMessage; message: string; status: string }>(apiKey, '/v1/messages/send', {
    method: 'POST',
    body: JSON.stringify({ from: args.from, to: args.to, content: args.content, request_id: args.requestId }),
  });
  return body.data;
}

/** Mirrors the real httpSMS Phone entity — only the fields this app actually uses. */
export type HttpSmsPhone = { id: string; phone_number: string };

/** GET /v1/phones — every phone registered on this httpSMS account. */
export async function listPhones(apiKey: string): Promise<HttpSmsPhone[]> {
  const body = await call<{ data: HttpSmsPhone[] }>(apiKey, '/v1/phones');
  return body.data;
}
