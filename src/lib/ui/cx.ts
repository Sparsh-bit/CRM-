/** Tiny classname joiner — no new dependency (clsx/cva) for what one line does. */
export function cx(...classes: (string | false | null | undefined)[]): string {
  return classes.filter(Boolean).join(' ');
}
