/**
 * The one semantic color vocabulary the whole app shares: five tones, each
 * meaning one thing (accent = primary/active, good = success, warn =
 * warning, bad = error, muted = neutral/inactive) — never expanded
 * speculatively, never reused for an unrelated meaning. Was previously
 * defined twice (src/lib/ui/status.ts and src/app/workforce/_lib/status.ts,
 * byte-for-byte identical) — consolidated here so both import one
 * definition instead of two that could quietly drift apart.
 */
export type Tone = 'good' | 'warn' | 'bad' | 'muted' | 'accent';

export function pillClass(tone: Tone) {
  return `pill pill-${tone}`;
}
