import { cx } from '@/lib/ui/cx';

/**
 * The shared `.card` shape (bg-panel, border-line, rounded-xl, p-5) as a
 * component instead of a copy-pasted className string (was repeated ~69
 * times across src/app with no single definition to change). Server
 * component — no interactivity here, just the shape.
 *
 * `min-w-0` is load-bearing, not decorative: a Card used as a CSS Grid or
 * flex item defaults to `min-width: auto`, which refuses to shrink below
 * its content's natural width NO MATTER what `truncate`/`min-w-0` a
 * descendant has — found as a real horizontal-overflow bug on mobile
 * (workforce overview + agents grid, confirmed via Playwright at 320-390px)
 * where a Card holding a long agent name forced the whole page wider than
 * the viewport. Baking it into every Card here means the next grid of
 * cards doesn't get to reintroduce the same bug.
 */
export function Card({ className, ...props }: React.ComponentPropsWithoutRef<'div'>) {
  return <div className={cx('card min-w-0', className)} {...props} />;
}

/** A tighter Card for a stat tile / small metric — same border/radius, less padding. */
export function CardTight({ className, ...props }: React.ComponentPropsWithoutRef<'div'>) {
  return <div className={cx('card min-w-0 py-3', className)} {...props} />;
}
