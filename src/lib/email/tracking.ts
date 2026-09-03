const TAG_RE = /<[^>]+>/;

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

/** Rewrite links through the click tracker. Unsubscribe links are left alone. */
export function rewriteLinks(html: string, appUrl: string, trackingId: string): string {
  return html.replace(/href="(https?:\/\/[^"]+)"/g, (m, url: string) => {
    if (url.includes('/api/u/')) return m;
    return `href="${appUrl}/api/t/c/${trackingId}?u=${encodeURIComponent(url)}"`;
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
