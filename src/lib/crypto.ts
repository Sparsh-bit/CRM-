import crypto from 'node:crypto';

// Secrets (SMTP passwords, API keys, OAuth tokens) are never stored in plaintext.
function key() {
  const s = process.env.AUTH_SECRET || 'dev-only-insecure-secret-change-me';
  return crypto.createHash('sha256').update(s).digest();
}

export function encrypt(plain: string): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return [iv.toString('base64'), c.getAuthTag().toString('base64'), enc.toString('base64')].join('.');
}

export function decrypt(payload: string | null | undefined): string {
  if (!payload) return '';
  const [iv, tag, data] = payload.split('.');
  if (!iv || !tag || !data) return '';
  const d = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]).toString('utf8');
}
