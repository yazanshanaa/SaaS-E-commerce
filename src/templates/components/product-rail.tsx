'use client';

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';

/**
 * A horizontal product rail with snap points and two arrow buttons — «وصل حديثاً» and «الأكثر
 * مبيعاً» on every Shopify and Salla home page are this shape, not a second grid.
 *
 * The scrolling is native (`overflow-x: auto` + `scroll-snap-type`), so it works with a finger, a
 * trackpad and the keyboard without any script; the arrows are the desktop convenience and hide
 * themselves at either end. In RTL the "next" arrow scrolls toward negative x, which
 * `scrollBy({ left: -width })` handles because the browser reports RTL scroll positions as
 * negative in every modern engine.
 */
export function ProductRail({
  children,
  columns,
  labels,
}: {
  children: ReactNode;
  columns: number;
  labels: { previous: string; next: string };
}) {
  const track = useRef<HTMLDivElement | null>(null);
  const [edges, setEdges] = useState({ start: true, end: false });

  useEffect(() => {
    const element = track.current;
    if (!element) return;
    const update = () => {
      const max = element.scrollWidth - element.clientWidth;
      const position = Math.abs(element.scrollLeft);
      setEdges({ start: position <= 2, end: position >= max - 2 });
    };
    update();
    element.addEventListener('scroll', update, { passive: true });
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => {
      element.removeEventListener('scroll', update);
      observer.disconnect();
    };
  }, []);

  const step = (direction: 1 | -1) => {
    const element = track.current;
    if (!element) return;
    // "Next" moves toward the reading end: in RTL that is the negative direction.
    const rtl = getComputedStyle(element).direction === 'rtl';
    const distance = element.clientWidth * 0.8 * direction * (rtl ? -1 : 1);
    element.scrollBy({ left: distance, behavior: 'smooth' });
  };

  return (
    <div className="sf-rail-wrap" data-start={edges.start} data-end={edges.end}>
      <button
        type="button"
        className="sf-rail-arrow sf-rail-arrow--prev"
        aria-label={labels.previous}
        onClick={() => step(-1)}
        disabled={edges.start}
      >
        <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
          <path d="m9 6 6 6-6 6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      <div
        ref={track}
        className="sf-grid sf-grid--rail"
        style={{ '--sf-cols': columns } as CSSProperties}
      >
        {children}
      </div>
      <button
        type="button"
        className="sf-rail-arrow sf-rail-arrow--next"
        aria-label={labels.next}
        onClick={() => step(1)}
        disabled={edges.end}
      >
        <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
          <path d="m15 6-6 6 6 6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
    </div>
  );
}
