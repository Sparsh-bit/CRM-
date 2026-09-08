'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * Fades a section in as it enters the viewport. Native IntersectionObserver,
 * no animation library. Renders visible immediately if the browser doesn't
 * support IO, and skips the transition entirely under prefers-reduced-motion
 * (checked via the media query, not a prop, so it degrades correctly even
 * for a server-rendered first paint).
 */
export function Reveal({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') { setVisible(true); return; }
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting) { setVisible(true); io.disconnect(); } },
      { threshold: 0.15 },
    );
    io.observe(el);
    // Guaranteed fallback: a backgrounded/throttled tab can clamp IntersectionObserver
    // callbacks indefinitely (observed directly while browser-testing this page), which
    // would otherwise leave real content permanently invisible. Content must never depend
    // on a callback firing to become visible at all.
    const fallback = setTimeout(() => setVisible(true), 1200);
    return () => { io.disconnect(); clearTimeout(fallback); };
  }, []);

  return (
    <div
      ref={ref}
      className={`transition-[opacity,transform] duration-700 ease-out motion-reduce:transition-none motion-reduce:transform-none ${
        visible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4'
      } ${className}`}
    >
      {children}
    </div>
  );
}
