import type { Tone } from '@/lib/ui/tone';
import { pillClass } from '@/lib/ui/tone';
import { cx } from '@/lib/ui/cx';

/**
 * A status pill as a component instead of `<span className={pillClass(tone)}>`
 * repeated at 19+ call sites. Takes {label, tone} — the exact shape every
 * `*Meta`/`*_META` lookup in the app already returns, so callers just spread
 * the result: `<Badge {...campaignStatusMeta(c.status)} />`.
 */
export function Badge({ label, tone, className }: { label: string; tone: Tone; className?: string }) {
  return <span className={cx(pillClass(tone), className)}>{label}</span>;
}
