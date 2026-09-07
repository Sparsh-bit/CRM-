/**
 * SmsService — the one abstraction the rest of the app is allowed to depend
 * on for SMS. Nothing outside this directory imports ./httpsms directly,
 * exactly mirroring email/senders.ts's sendEmail(mailbox, args) shape so
 * adding a second provider later (Twilio, another gateway) never changes a
 * caller — only the switch inside sendSms().
 */
import { decrypt } from '../crypto';
import * as httpsms from './httpsms';

export type SmsGatewayLike = {
  id: string;
  provider: string;
  phoneNumber: string;
  apiKeyEnc: string | null;
};

export type SendArgs = {
  to: string;
  text: string;
  /** Passed through to the provider's own idempotency key where supported (httpSMS: request_id). */
  requestId?: string;
};

export type SendResult = { providerId: string | null };

export async function sendSms(gateway: SmsGatewayLike, args: SendArgs): Promise<SendResult> {
  switch (gateway.provider) {
    case 'httpsms': return sendViaHttpSms(gateway, args);
    default: throw new Error(`Unknown SMS provider: ${gateway.provider}`);
  }
}

async function sendViaHttpSms(gateway: SmsGatewayLike, args: SendArgs): Promise<SendResult> {
  const apiKey = decrypt(gateway.apiKeyEnc);
  if (!apiKey) throw new Error('This SMS gateway has no API key configured.');
  const message = await httpsms.sendMessage(apiKey, {
    from: gateway.phoneNumber, to: args.to, content: args.text, requestId: args.requestId,
  });
  return { providerId: message.id };
}

/**
 * What a "Test Connection" click can honestly report. httpSMS's public API
 * does not expose a live online/offline flag on GET /v1/phones — that state
 * is tracked server-side via heartbeat events, not returned to API callers.
 * So "connected" here means "the API key is valid AND this phone number is
 * registered on the account" — a real, verified fact — not "the phone is
 * online right now", which this integration cannot check synchronously.
 */
export type ConnectionStatus = 'connected' | 'invalid_credentials' | 'device_unavailable' | 'provider_unavailable' | 'not_configured';
export type ConnectionResult = { status: ConnectionStatus; message: string };

export async function testConnection(gateway: SmsGatewayLike): Promise<ConnectionResult> {
  if (gateway.provider !== 'httpsms') {
    return { status: 'not_configured', message: `Unknown SMS provider "${gateway.provider}".` };
  }
  const apiKey = decrypt(gateway.apiKeyEnc);
  if (!apiKey || !gateway.phoneNumber) {
    return { status: 'not_configured', message: 'API key or phone number is not set for this gateway.' };
  }

  try {
    const phones = await httpsms.listPhones(apiKey);
    const registered = phones.some((p) => p.phone_number === gateway.phoneNumber);
    if (registered) {
      return {
        status: 'connected',
        message: `${gateway.phoneNumber} is registered on this httpSMS account. This confirms the API key works and the number exists — it does not confirm the Android app is online right now.`,
      };
    }
    return {
      status: 'device_unavailable',
      message: `No phone matching ${gateway.phoneNumber} is registered on this httpSMS account. Open the httpSMS Android app on that device and confirm the number, or re-check for a typo.`,
    };
  } catch (e) {
    if (e instanceof httpsms.HttpSmsError) {
      if (e.kind === 'invalid_credentials') return { status: 'invalid_credentials', message: e.message };
      return { status: 'provider_unavailable', message: e.message };
    }
    return { status: 'provider_unavailable', message: e instanceof Error ? e.message : String(e) };
  }
}
