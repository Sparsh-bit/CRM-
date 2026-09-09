import Link from 'next/link';
import { cx } from '@/lib/ui/cx';

type Variant = 'primary' | 'secondary';

type ButtonProps = { variant?: Variant; href?: string } & (
  | ({ href: string } & React.ComponentPropsWithoutRef<'a'>)
  | ({ href?: undefined } & React.ComponentPropsWithoutRef<'button'>)
);

/**
 * The shared .btn/.btn-sec shape as one component instead of the className
 * repeated at ~41 call sites — renders a real Link when `href` is given
 * (a CTA that navigates) or a native <button> otherwise (a form action,
 * unchanged server-component-friendly behavior — no client JS needed here).
 */
export function Button({ variant = 'primary', className, href, ...props }: ButtonProps) {
  const cls = cx(variant === 'primary' ? 'btn' : 'btn-sec', className);
  if (href) return <Link href={href} className={cls} {...(props as React.ComponentPropsWithoutRef<'a'>)} />;
  return <button className={cls} {...(props as React.ComponentPropsWithoutRef<'button'>)} />;
}
