/**
 * Evolution API client (https://github.com/EvolutionAPI/evolution-api).
 * Self-hosted WhatsApp gateway: create an instance, scan a QR from the app,
 * then POST text. Auth is the `apikey` header.
 */

const base = () => (process.env.EVOLUTION_API_URL || 'http://localhost:8080').replace(/\/+$/, '');
const key = () => process.env.EVOLUTION_API_KEY || '';

async function call<T>(path: string, init: RequestInit = {}, token?: string): Promise<T> {
  const res = await fetch(`${base()}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', apikey: token || key(), ...(init.headers ?? {}) },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Evolution ${res.status} ${path}: ${text.slice(0, 400)}`);
  return (text ? JSON.parse(text) : {}) as T;
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
