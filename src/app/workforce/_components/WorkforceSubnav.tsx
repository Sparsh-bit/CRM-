'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const TABS = [
  ['/workforce', 'Overview'],
  ['/workforce/command-center', 'Command Center'],
  ['/workforce/agents', 'Agents'],
  ['/workforce/tasks', 'Tasks'],
  ['/workforce/approvals', 'Approvals'],
];

export function WorkforceSubnav() {
  const pathname = usePathname();
  return (
    <nav className="flex gap-1 border-b border-line -mb-px overflow-x-auto">
      {TABS.map(([href, label]) => {
        const active = href === '/workforce' ? pathname === href : pathname.startsWith(href);
        return (
          <Link
            key={href}
            href={href}
            className={`px-3 py-2 text-sm border-b-2 -mb-px transition-colors whitespace-nowrap shrink-0 ${
              active ? 'border-accent text-slate-100 font-medium' : 'border-transparent text-muted hover:text-slate-200'
            }`}
          >
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
