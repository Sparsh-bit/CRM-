import nodemailer from 'nodemailer';
import { decrypt } from '../crypto';

export type SendArgs = {
  to: string;
  subject: string;
  html: string;
  text: string;
  headers?: Record<string, string>;
};

export type MailboxLike = {
  id: string; provider: string; fromName: string; fromEmail: string; replyTo: string | null;
  smtpHost: string | null; smtpPort: number | null; smtpSecure: boolean;
  smtpUser: string | null; smtpPassEnc: string | null;
  apiKeyEnc: string | null; oauthAccessEnc: string | null; oauthRefreshEnc: string | null;
  oauthExpiresAt: Date | null;
};

export type SendResult = { providerId: string | null };

export async function sendEmail(mb: MailboxLike, args: SendArgs): Promise<SendResult> {
  switch (mb.provider) {
    case 'smtp':          return sendSmtp(mb, args);
    case 'resend':        return sendResend(mb, args);
    case 'gmail_oauth':   return sendGmail(mb, args);
    case 'outlook_oauth': return sendOutlook(mb, args);
    default: throw new Error(`Unknown mailbox provider: ${mb.provider}`);
  }
}

// ── SMTP / Gmail app password ────────────────────────────────────────────────
async function sendSmtp(mb: MailboxLike, a: SendArgs): Promise<SendResult> {
  if (!mb.smtpHost) throw new Error('SMTP host missing');
  const t = nodemailer.createTransport({
    host: mb.smtpHost,
    port: mb.smtpPort ?? 465,
    secure: mb.smtpSecure,
    auth: { user: mb.smtpUser ?? mb.fromEmail, pass: decrypt(mb.smtpPassEnc) },
  });
  const info = await t.sendMail({
    from: `"${mb.fromName}" <${mb.fromEmail}>`,
    replyTo: mb.replyTo ?? undefined,
    to: a.to, subject: a.subject, text: a.text, html: a.html, headers: a.headers,
  });
  return { providerId: info.messageId ?? null };
}

// ── Resend ───────────────────────────────────────────────────────────────────
async function sendResend(mb: MailboxLike, a: SendArgs): Promise<SendResult> {
  const key = decrypt(mb.apiKeyEnc) || process.env.RESEND_API_KEY || '';
  if (!key) throw new Error('Resend API key missing');
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({
      from: `${mb.fromName} <${mb.fromEmail}>`,
      to: [a.to],
      reply_to: mb.replyTo ?? undefined,
      subject: a.subject, html: a.html, text: a.text, headers: a.headers,
    }),
  });
  if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text()}`);
  const j = (await res.json()) as { id?: string };
  return { providerId: j.id ?? null };
}

// ── OAuth token refresh ──────────────────────────────────────────────────────
export async function refreshOauth(mb: MailboxLike): Promise<{ access: string; expiresAt: Date } | null> {
  const refresh = decrypt(mb.oauthRefreshEnc);
  if (!refresh) return null;
  const google = mb.provider === 'gmail_oauth';
  const url = google
    ? 'https://oauth2.googleapis.com/token'
    : `https://login.microsoftonline.com/${process.env.MICROSOFT_TENANT || 'common'}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refresh,
    client_id: (google ? process.env.GOOGLE_CLIENT_ID : process.env.MICROSOFT_CLIENT_ID) || '',
    client_secret: (google ? process.env.GOOGLE_CLIENT_SECRET : process.env.MICROSOFT_CLIENT_SECRET) || '',
  });
  const res = await fetch(url, { method: 'POST', body });
  if (!res.ok) throw new Error(`OAuth refresh ${res.status}: ${await res.text()}`);
  const j = (await res.json()) as { access_token: string; expires_in: number };
  return { access: j.access_token, expiresAt: new Date(Date.now() + (j.expires_in - 60) * 1000) };
}

async function accessToken(mb: MailboxLike): Promise<string> {
  const current = decrypt(mb.oauthAccessEnc);
  const stillGood = mb.oauthExpiresAt && mb.oauthExpiresAt.getTime() > Date.now() + 30_000;
  if (current && stillGood) return current;
  const r = await refreshOauth(mb);
  if (!r) throw new Error('No OAuth refresh token for this mailbox — reconnect it');
  return r.access;
}

function rfc822(mb: MailboxLike, a: SendArgs): string {
  const boundary = 'b_' + Math.random().toString(36).slice(2);
  const head = [
    `From: "${mb.fromName}" <${mb.fromEmail}>`,
    `To: ${a.to}`,
    mb.replyTo ? `Reply-To: ${mb.replyTo}` : '',
    `Subject: ${a.subject}`,
    'MIME-Version: 1.0',
    ...Object.entries(a.headers ?? {}).map(([k, v]) => `${k}: ${v}`),
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ].filter(Boolean).join('\r\n');
  return [
    head, '',
    `--${boundary}`, 'Content-Type: text/plain; charset="UTF-8"', '', a.text, '',
    `--${boundary}`, 'Content-Type: text/html; charset="UTF-8"', '', a.html, '',
    `--${boundary}--`, '',
  ].join('\r\n');
}

async function sendGmail(mb: MailboxLike, a: SendArgs): Promise<SendResult> {
  const token = await accessToken(mb);
  const raw = Buffer.from(rfc822(mb, a)).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ raw }),
  });
  if (!res.ok) throw new Error(`Gmail ${res.status}: ${await res.text()}`);
  const j = (await res.json()) as { id?: string };
  return { providerId: j.id ?? null };
}

async function sendOutlook(mb: MailboxLike, a: SendArgs): Promise<SendResult> {
  const token = await accessToken(mb);
  const res = await fetch('https://graph.microsoft.com/v1.0/me/sendMail', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({
      message: {
        subject: a.subject,
        body: { contentType: 'HTML', content: a.html },
        toRecipients: [{ emailAddress: { address: a.to } }],
        replyTo: mb.replyTo ? [{ emailAddress: { address: mb.replyTo } }] : undefined,
        internetMessageHeaders: Object.entries(a.headers ?? {})
          .filter(([k]) => k.toLowerCase().startsWith('x-') || k.toLowerCase().startsWith('list-'))
          .map(([name, value]) => ({ name, value })),
      },
      saveToSentItems: true,
    }),
  });
  if (!res.ok) throw new Error(`Graph ${res.status}: ${await res.text()}`);
  return { providerId: null };
}
