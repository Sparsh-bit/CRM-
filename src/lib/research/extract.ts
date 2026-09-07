/**
 * HTML -> clean, readable text. Uses Mozilla's own Readability library (the
 * exact engine behind Firefox Reader View) over a jsdom document — a mature,
 * actively-maintained, MIT-licensed pair with a stable API and no browser
 * automation needed, chosen over hand-rolling an HTML-stripping regex (fails
 * on real-world pages) or a headless browser (heavy, needs a sandboxed
 * Chromium the deployment target may not have).
 */
import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';

const maxTextChars = () => Number(process.env.RESEARCH_EXTRACT_MAX_CHARS ?? 20_000); // bounds the AI prompt built from this later; read at call time (see webFetch.ts)

export type Extraction = {
  title: string;
  byline: string | null;
  excerpt: string;
  textContent: string; // truncated to MAX_TEXT_CHARS
  truncated: boolean;
  length: number; // original, pre-truncation length
};

export type ExtractResult = { ok: true; extraction: Extraction } | { ok: false; reason: string };

export function extractReadableContent(html: string, url: string): ExtractResult {
  let dom: JSDOM;
  try {
    dom = new JSDOM(html, { url });
  } catch (e) {
    return { ok: false, reason: `Could not parse HTML from ${url}: ${e instanceof Error ? e.message : String(e)}` };
  }

  let article: ReturnType<Readability['parse']>;
  try {
    article = new Readability(dom.window.document).parse();
  } catch (e) {
    return { ok: false, reason: `Readability could not extract an article from ${url}: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (!article || !article.textContent?.trim()) {
    return { ok: false, reason: `No readable article content found at ${url} (not an article page, or content is script-rendered).` };
  }

  const full = article.textContent.trim();
  const cap = maxTextChars();
  const truncated = full.length > cap;
  return {
    ok: true,
    extraction: {
      title: article.title ?? '',
      byline: article.byline ?? null,
      excerpt: article.excerpt ?? full.slice(0, 300),
      textContent: truncated ? full.slice(0, cap) : full,
      truncated,
      length: full.length,
    },
  };
}
