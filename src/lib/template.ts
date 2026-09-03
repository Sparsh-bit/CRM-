/**
 * Merge-tag engine.
 *
 *   {{first_name}}                       → canonical or custom field, case/space insensitive
 *   {{first_name | fallback: "there"}}   → fallback when the field is empty
 *   {{company | upper}}                  → filters: upper, lower, title, trim, first_word
 *   {spin|tax|variants}                  → picks one at random, deterministic per seed
 *
 * Unresolved tags are reported so a campaign can be blocked before it sends
 * "Hi {{first_name}}," to 68 people.
 */

export type MergeContext = Record<string, unknown>;

const FILTERS: Record<string, (v: string, arg?: string) => string> = {
  upper: (v) => v.toUpperCase(),
  lower: (v) => v.toLowerCase(),
  trim: (v) => v.trim(),
  first_word: (v) => v.trim().split(/\s+/)[0] ?? '',
  title: (v) => v.replace(/\w\S*/g, (t) => t[0].toUpperCase() + t.slice(1).toLowerCase()),
};

function norm(k: string) {
  return k.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

export function flattenContext(ctx: MergeContext): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(ctx)) {
    if (v === null || v === undefined) continue;
    if (typeof v === 'object' && !Array.isArray(v)) {
      for (const [k2, v2] of Object.entries(v as Record<string, unknown>)) {
        if (v2 === null || v2 === undefined) continue;
        out[norm(k2)] = String(v2);
      }
      continue;
    }
    out[norm(k)] = Array.isArray(v) ? v.join(', ') : String(v);
  }
  return out;
}

function hash(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return Math.abs(h);
}

export function resolveSpintax(input: string, seed = 'seed'): string {
  let out = input, guard = 0;
  const re = /\{([^{}]*\|[^{}]*)\}/;
  while (re.test(out) && guard++ < 50) {
    out = out.replace(re, (_m, group: string) => {
      const parts = group.split('|');
      return parts[hash(seed + group) % parts.length];
    });
  }
  return out;
}

export type RenderResult = { text: string; missing: string[] };

/**
 * Order matters: merge tags are resolved FIRST and parked behind sentinels, then
 * spintax runs. Otherwise `{{name | fallback: "there"}}` looks like a spintax
 * group to the `{a|b}` matcher and gets shredded.
 */
export function render(tpl: string, ctx: MergeContext, seed = 'seed'): RenderResult {
  const flat = flattenContext(ctx);
  const missing = new Set<string>();
  const parked: string[] = [];

  const parkedText = tpl.replace(
    /\{\{\s*([a-zA-Z0-9_. ]+?)\s*(?:\|\s*([^}]+?))?\s*\}\}/g,
    (_m, rawKey: string, rawFilters?: string) => {
      let value = flat[norm(rawKey)] ?? '';
      let fallback = '';
      if (rawFilters) {
        for (const seg of rawFilters.split('|').map((x) => x.trim()).filter(Boolean)) {
          const fb = seg.match(/^fallback\s*:\s*["']?(.*?)["']?$/i);
          if (fb) { fallback = fb[1]; continue; }
          const fn = FILTERS[seg.toLowerCase()];
          if (fn && value) value = fn(value);
        }
      }
      if (!value) {
        if (fallback) value = fallback;
        else missing.add(norm(rawKey));
      }
      parked.push(value);
      return `\u0000${parked.length - 1}\u0000`;
    },
  );

  const spun = resolveSpintax(parkedText, seed);
  const text = spun.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => parked[Number(i)] ?? '');

  return { text, missing: [...missing] };
}

/** All merge tags used in a template — powers the "available variables" UI. */
export function extractTags(tpl: string): string[] {
  const out = new Set<string>();
  for (const m of tpl.matchAll(/\{\{\s*([a-zA-Z0-9_. ]+?)\s*(?:\|[^}]*)?\}\}/g)) out.add(norm(m[1]));
  return [...out];
}
