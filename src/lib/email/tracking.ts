import { createHmac, timingSafeEqual } from 'node:crypto';
import { authSecret } from '../env';

const TAG_RE = /<[^>]+>/;

/**
 * Ties a click-tracking redirect to the exact (trackingId, url) pair it was
 * generated for — found by a peer session's audit as a real open redirect:
 * src/app/api/t/c/[tid]/route.ts used to accept ANY `u` param with an
 * http(s) scheme and redirect to it unconditionally, regardless of whether
 * that URL had anything to do with the tracked message. Anyone could build
 * `/api/t/c/<anything>?u=https://evil.example` and get an open redirect off
 * this app's trusted domain. Signing the pair when the link is generated
 * (here) and verifying it before redirecting (the route) closes that:
 * forging a valid signature requires knowing AUTH_SECRET.
 */
export function signClickUrl(trackingId: string, url: string): string {
  return createHmac('sha256', authSecret()).update(`${trackingId}:${url}`).digest('hex').slice(0, 20);
}

export function verifyClickUrl(trackingId: string, url: string, sig: string | null): boolean {
  if (!sig) return false;
  const expected = signClickUrl(trackingId, url);
  const a = Buffer.from(sig), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function textToHtml(text: string): string {
  const esc = text
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const linked = esc.replace(
    /(https?:\/\/[^\s<]+)/g,
    (u) => `<a href="${u}" style="color:#2b5fd9">${u}</a>`,
  );
  return `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.55;color:#1a1a1a">${linked.replace(/\n/g, '<br>')}</div>`;
}

export function isHtml(body: string): boolean {
  return TAG_RE.test(body);
}

export function appendPixel(html: string, appUrl: string, trackingId: string): string {
  return `${html}<img src="${appUrl}/api/t/o/${trackingId}" width="1" height="1" alt="" style="display:block;border:0" />`;
}

/** Rewrite links through the click tracker. Unsubscribe links are left alone. Each rewritten link is signed (see signClickUrl) so the redirect route can verify it wasn't tampered with or forged. */
export function rewriteLinks(html: string, appUrl: string, trackingId: string): string {
  return html.replace(/href="(https?:\/\/[^"]+)"/g, (m, url: string) => {
    if (url.includes('/api/u/')) return m;
    const sig = signClickUrl(trackingId, url);
    return `href="${appUrl}/api/t/c/${trackingId}?u=${encodeURIComponent(url)}&sig=${sig}"`;
  });
}

export function unsubscribeBlock(appUrl: string, trackingId: string): string {
  const url = `${appUrl}/api/u/${trackingId}`;
  return `<div style="margin-top:22px;font-size:12px;color:#8a8a8a;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif">
Not the right person, or not interested? <a href="${url}" style="color:#8a8a8a">Unsubscribe</a> and I won't email again.
</div>`;
}

export function unsubscribeHeaders(appUrl: string, trackingId: string, fromEmail: string) {
  return {
    'List-Unsubscribe': `<${appUrl}/api/u/${trackingId}>, <mailto:${fromEmail}?subject=unsubscribe>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  };
}
