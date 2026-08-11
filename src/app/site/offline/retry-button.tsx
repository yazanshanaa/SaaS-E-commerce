'use client';

/**
 * Reload, from a cached document.
 *
 * `location.reload()` re-requests the URL the visitor actually wanted; the service worker tries
 * the network first and only falls back here again if it is still down. A `<a href>` would work
 * too, but it would need a target — and this page does not know which URL the visitor was trying
 * to reach, because the worker substituted it for whatever navigation failed.
 *
 * A client component for one line, rather than an inline `onClick` on a server-rendered button:
 * the App Router does not allow the latter, and a `<form>` posting to nothing would be worse.
 */
export function RetryButton({ label }: { label: string }) {
  return (
    <button type="button" className="sf-btn" onClick={() => window.location.reload()}>
      {label}
    </button>
  );
}
