'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';

export function NavBar({ items }: { items: [string, string][] }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  // Close the mobile menu on route change, not just on link click, so a
  // browser back/forward navigation doesn't leave it stuck open.
  useEffect(() => { setOpen(false); }, [pathname]);

  const isActive = (href: string) => (href === '/' ? pathname === '/' : pathname.startsWith(href));

  return (
    <>
      <nav className="hidden lg:flex gap-1 text-sm overflow-x-auto">
        {items.map(([href, label]) => (
          <Link
            key={href}
            href={href}
            className={`px-3 py-1.5 rounded-md whitespace-nowrap ${
              isActive(href) ? 'text-slate-100 bg-line' : 'text-muted hover:text-slate-100 hover:bg-line'
            }`}
          >
            {label}
          </Link>
        ))}
      </nav>

      <button
        className="lg:hidden text-muted hover:text-slate-100 px-2 py-1.5 rounded-md hover:bg-line"
        aria-label={open ? 'Close menu' : 'Open menu'}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {open ? 'Close' : 'Menu'}
      </button>

      {open && (
        <nav className="lg:hidden absolute left-0 right-0 top-14 bg-panel border-b border-line px-6 py-3 flex flex-col gap-1 text-sm z-10">
          {items.map(([href, label]) => (
            <Link
              key={href}
              href={href}
              className={`px-3 py-2 rounded-md ${
                isActive(href) ? 'text-slate-100 bg-line' : 'text-muted hover:text-slate-100 hover:bg-line'
              }`}
            >
              {label}
            </Link>
          ))}
        </nav>
      )}
    </>
  );
}
