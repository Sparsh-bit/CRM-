import Link from 'next/link';
import type { Tone } from '@/lib/ui/tone';
import { cx } from '@/lib/ui/cx';

const TONE_TEXT: Record<Tone, string> = {
  good: 'text-good', warn: 'text-warn', bad: 'text-bad', accent: 'text-accent', muted: '',
};

/**
 * One real number, well presented — replaces the raw `<div className="card">
 * <div className="text-xs text-muted">{label}</div><div className="text-lg
 * font-semibold">{value}</div></div>` repeated across the dashboard and
 * workforce overview. `tone` tints the number itself (e.g. a nonzero
 * "Failed tasks" tile reading in `bad`) — omit it for a plain neutral tile.
 * `href` makes the whole tile a real link to wherever that number is
 * explained, instead of a dead-end number.
 */
export function StatTile({
  label, value, sub, tone, href,
}: { label: string; value: string | number; sub?: string; tone?: Tone; href?: string }) {
  const body = (
    <>
      <div className="text-meta">{label}</div>
      <div className={cx('metric mt-1.5', tone && TONE_TEXT[tone])}>{value}</div>
      {sub && <div className="text-secondary mt-1">{sub}</div>}
    </>
  );
  if (href) {
    return (
      <Link href={href} className="card min-w-0 py-4 block hover:border-accent/40 transition">
        {body}
      </Link>
    );
  }
  return <div className="card min-w-0 py-4">{body}</div>;
}
