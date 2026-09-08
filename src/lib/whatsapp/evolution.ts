/**
 * Evolution API client (https://github.com/EvolutionAPI/evolution-api).
 * Self-hosted WhatsApp gateway: create an instance, scan a QR from the app,
 * then POST text. Auth is the `apikey` header.
 */

const base = () => (process.env.EVOLUTION_API_URL || 'http://localhost:8080').replace(/\/+$/, '');
const key = () => process.env.EVOLUTION_API_KEY || '';
const TIMEOUT_MS = () => Number(process.env.EVOLUTION_TIMEOUT_MS ?? 15_000);

export type EvolutionErrorKind =
  | 'unavailable'    // DNS/refused/timeout — nothing is listening at EVOLUTION_API_URL
  | 'wrong_service'  // got HTML back, not JSON — URL points at a webpage, not the API
  | 'unauthorized'   // 401 — bad EVOLUTION_API_KEY / instance token
  | 'not_found'      // 404 — instance name doesn't exist on this server
  | 'server_error'   // 5xx — Evolution API itself is unhealthy
  | 'bad_request'    // other 4xx
  | 'malformed';     // 2xx but the body wasn't valid JSON

export class EvolutionApiError extends Error {
  constructor(message: string, public readonly kind: EvolutionErrorKind, public readonly detail: string) {
    super(message);
  }
}

async function call<T>(path: string, init: RequestInit = {}, token?: string): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS());
  let res: Response;
  try {
    res = await fetch(`${base()}${path}`, {
      ...init,
      signal: controller.signal,
      headers: { 'content-type': 'application/json', apikey: token || key(), ...(init.headers ?? {}) },
    });
  } catch (e) {
    clearTimeout(timer);
    const detail = e instanceof Error ? e.message : String(e);
    if (controller.signal.aborted) {
      throw new EvolutionApiError(`Evolution API at ${base()} did not respond within ${TIMEOUT_MS()}ms.`, 'unavailable', detail);
    }
    throw new EvolutionApiError(`Could not reach the Evolution API at ${base()}. Check EVOLUTION_API_URL and that the service is running.`, 'unavailable', detail);
  }
  clearTimeout(timer);

  const text = await res.text();
  const contentType = res.headers.get('content-type') ?? '';
  const looksLikeHtml = contentType.includes('text/html') || /^\s*<(!doctype|html)/i.test(text);
  if (looksLikeHtml) {
    throw new EvolutionApiError(
      'Evolution API URL appears to point to the wrong service (it returned a web page, not JSON). Double-check EVOLUTION_API_URL.',
      'wrong_service',
      text.slice(0, 2000),
    );
  }

  if (!res.ok) {
    const kind: EvolutionErrorKind =
      res.status === 401 ? 'unauthorized' :
      res.status === 404 ? 'not_found' :
      res.status >= 500 ? 'server_error' : 'bad_request';
    const messages: Record<EvolutionErrorKind, string> = {
      unauthorized: 'Evolution API rejected the request — the API key is missing or invalid.',
      not_found: 'Evolution API returned 404 — this instance does not exist on that server (it may have been deleted, or the instance name is wrong).',
      server_error: `Evolution API returned a server error (${res.status}) — the service itself is unhealthy right now.`,
      bad_request: `Evolution API rejected the request (${res.status}).`,
      unavailable: 'Evolution API is unavailable.', wrong_service: 'Evolution API URL appears to point to the wrong service.', malformed: 'Evolution API returned an unreadable response.',
    };
    throw new EvolutionApiError(messages[kind], kind, `${res.status} ${path}: ${text.slice(0, 2000)}`);
  }

  try {
    return (text ? JSON.parse(text) : {}) as T;
  } catch {
    throw new EvolutionApiError('Evolution API returned a response that could not be parsed as JSON.', 'malformed', text.slice(0, 2000));
  }
}

/** Human message + expandable technical detail — see src/lib/errors/display.ts. Never includes the API key. */
export function humanizeEvolutionError(e: unknown): { message: string; detail: string } {
  if (e instanceof EvolutionApiError) return { message: e.message, detail: e.detail };
  return { message: e instanceof Error ? e.message : String(e), detail: '' };
}

export type CreateInstanceResult = {
  instance?: { instanceName?: string; instanceId?: string; status?: string };
  hash?: string | { apikey?: string };
  qrcode?: { base64?: string; code?: string };
};

export async function createInstance(instanceName: string, number?: string, webhookUrl?: string) {
  return call<CreateInstanceResult>('/instance/create', {
    method: 'POST',
    body: JSON.stringify({
      instanceName,
      number,
      qrcode: true,
      integration: 'WHATSAPP-BAILEYS',
      ...(webhookUrl
        ? {
            webhook: {
              url: webhookUrl,
              byEvents: false,
              base64: false,
              events: ['MESSAGES_UPSERT', 'CONNECTION_UPDATE', 'SEND_MESSAGE'],
            },
          }
        : {}),
    }),
  });
}

export async function connectInstance(instanceName: string) {
  return call<{ base64?: string; code?: string; pairingCode?: string }>(
    `/instance/connect/${encodeURIComponent(instanceName)}`,
  );
}

export async function connectionState(instanceName: string) {
  return call<{ instance?: { state?: string } }>(
    `/instance/connectionState/${encodeURIComponent(instanceName)}`,
  );
}

export async function logoutInstance(instanceName: string) {
  return call(`/instance/logout/${encodeURIComponent(instanceName)}`, { method: 'DELETE' });
}

export async function deleteInstance(instanceName: string) {
  return call(`/instance/delete/${encodeURIComponent(instanceName)}`, { method: 'DELETE' });
}

export type SendTextResult = { key?: { id?: string } };

/** `to` must be E.164 without the leading + (Evolution accepts either; we strip it). */
export async function sendText(
  instanceName: string,
  to: string,
  text: string,
  opts: { delayMs?: number; linkPreview?: boolean; token?: string } = {},
) {
  const number = to.replace(/^\+/, '').replace(/[^\d]/g, '');
  return call<SendTextResult>(
    `/message/sendText/${encodeURIComponent(instanceName)}`,
    {
      method: 'POST',
      body: JSON.stringify({
        number,
        text,
        delay: opts.delayMs ?? 1200,
        linkPreview: opts.linkPreview ?? false,
      }),
    },
    opts.token,
  );
}

export type SendMediaArgs = {
  mediatype: 'image' | 'video' | 'document' | 'audio';
  mimetype: string;   // e.g. "image/png", "application/pdf"
  media: string;      // public URL or base64
  fileName: string;
  caption?: string;
};

export async function sendMedia(
  instanceName: string,
  to: string,
  args: SendMediaArgs,
  opts: { delayMs?: number; token?: string } = {},
) {
  const number = to.replace(/^\+/, '').replace(/[^\d]/g, '');
  return call<SendTextResult>(
    `/message/sendMedia/${encodeURIComponent(instanceName)}`,
    { method: 'POST', body: JSON.stringify({ number, ...args, delay: opts.delayMs ?? 1200 }) },
    opts.token,
  );
}

export async function checkNumberExists(instanceName: string, numbers: string[], token?: string) {
  return call<{ exists: boolean; jid: string; number: string }[]>(
    `/chat/whatsappNumbers/${encodeURIComponent(instanceName)}`,
    { method: 'POST', body: JSON.stringify({ numbers: numbers.map((n) => n.replace(/^\+/, '')) }) },
    token,
  );
}

export async function setWebhook(instanceName: string, url: string) {
  return call(`/webhook/set/${encodeURIComponent(instanceName)}`, {
    method: 'POST',
    body: JSON.stringify({
      webhook: {
        enabled: true, url, byEvents: false, base64: false,
        events: ['MESSAGES_UPSERT', 'CONNECTION_UPDATE', 'SEND_MESSAGE'],
      },
    }),
  });
}
