'use client';

import { useEffect } from 'react';

/**
 * Inside the preview, links do not navigate and forms do not submit (Phase 11, Track 11.D).
 *
 * The preview document lives on app.*, so a product-card link that navigated the iframe would
 * land on a DASHBOARD route rendered inside the appearance screen — chrome inside chrome, and a
 * merchant who thinks they broke something. Capture-phase listeners neutralise both gestures
 * while leaving scrolling, hover states and the carousel's own buttons (which are
 * `type="button"`) alive — the preview stays a place to look at a design, not to operate a shop.
 *
 * This is also the second half of the read-only invariant: the first half is that this route's
 * server code writes nothing; this half is that the framed document cannot POST anything either.
 */
export function PreviewClickGuard() {
  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      const target = event.target as Element | null;
      if (target?.closest('a')) event.preventDefault();
    };
    const onSubmit = (event: Event) => {
      event.preventDefault();
    };

    document.addEventListener('click', onClick, true);
    // `auxclick` is the middle button, which does NOT raise a `click` — without this, a
    // middle-click on a product card opened the dashboard-framed route in a new tab.
    // Ctrl/Cmd-click needs nothing extra: that is a `click` carrying a modifier.
    document.addEventListener('auxclick', onClick, true);
    document.addEventListener('submit', onSubmit, true);
    return () => {
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('auxclick', onClick, true);
      document.removeEventListener('submit', onSubmit, true);
    };
  }, []);

  return null;
}
