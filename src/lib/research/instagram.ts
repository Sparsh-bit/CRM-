/**
 * Instagram URL handling — Section 3 & 16: no login bypass, no anti-bot
 * evasion, no scraping library that pretends to be the mobile app. This
 * reads exactly what an anonymous browser request can see: the Open Graph
 * meta tags Instagram serves on a public post/reel's page (title, a
 * description that often includes the caption, and a thumbnail image).
 * Instagram does not expose a playable video URL to an anonymous request —
 * so `videoUrl` is never returned; claiming one would be exactly the kind of
 * fabricated result Section 3 forbids. A private, deleted, or rate-limited
 * post returns a structured `unavailable` result, never a guess.
 */
import { fetchPage } from './webFetch';

export type InstagramResult =
  | { status: 'available'; data: { title: string | null; description: string | null; thumbnailUrl: string | null } }
  | { status: 'unavailable'; reason: string; suggestions: string[] };

const UPLOAD_SUGGESTION = 'Upload the Reel/video file directly with analyze_uploaded_media for a real transcript + visual analysis.';

export function isInstagramUrl(rawUrl: string): boolean {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'instagram.com' || host.endsWith('.instagram.com');
  } catch {
    return false;
  }
}

function metaContent(html: string, property: string): string | null {
  // A small, bounded regex over already-fetched HTML — not a DOM parse, since
  // we only need a handful of <meta property="..."> tags, not a full page.
  const re = new RegExp(`<meta[^>]+property=["']${property}["'][^>]+content=["']([^"']*)["']`, 'i');
  const alt = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+property=["']${property}["']`, 'i');
  const m = html.match(re) ?? html.match(alt);
  return m ? m[1] : null;
}

export async function analyzeInstagramUrl(url: string): Promise<InstagramResult> {
  if (!isInstagramUrl(url)) {
    return { status: 'unavailable', reason: `"${url}" is not an instagram.com URL.`, suggestions: [UPLOAD_SUGGESTION] };
  }

  const fetched = await fetchPage(url);
  if (!fetched.ok) {
    return { status: 'unavailable', reason: `Could not retrieve the post: ${fetched.reason}`, suggestions: [UPLOAD_SUGGESTION] };
  }

  // Instagram redirects an unauthenticated request for a private (or
  // sometimes rate-limited) post to its login page — a real, observable
  // signal, not a guess.
  if (/\/accounts\/login/.test(fetched.finalUrl) || /log ?into instagram/i.test(fetched.body)) {
    return {
      status: 'unavailable',
      reason: 'Instagram redirected to a login page — this post is private, age-gated, or otherwise not visible to an anonymous request.',
      suggestions: [UPLOAD_SUGGESTION, 'If the account is public, the post may still be visible from a logged-in browser — copy its caption manually as a fallback.'],
    };
  }

  const title = metaContent(fetched.body, 'og:title');
  const description = metaContent(fetched.body, 'og:description');
  const thumbnailUrl = metaContent(fetched.body, 'og:image');

  if (!title && !description && !thumbnailUrl) {
    return {
      status: 'unavailable',
      reason: 'The page loaded but exposed no Open Graph metadata — Instagram may be serving a script-rendered shell to unauthenticated requests, or the post is unavailable.',
      suggestions: [UPLOAD_SUGGESTION],
    };
  }

  return { status: 'available', data: { title, description, thumbnailUrl } };
}
