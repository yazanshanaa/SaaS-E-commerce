'use client';

import { useSyncExternalStore } from 'react';
import { CloseIcon } from './icons';

/**
 * The top announcement bar — a SITE-LEVEL element, not a section (docs/PHASES.md A2).
 *
 * Scheduling (start and end) is resolved on the SERVER before this ever renders: a bar outside
 * its window is not hidden here, it is never sent. That matters because "hidden by CSS" is
 * still in the HTML, and a scheduled offer that leaks into the page source a week early is an
 * offer the merchant has to honour.
 *
 * What is genuinely client-side is the dismissal, and only that. It is keyed by a SIGNATURE of
 * the bar's own content, so dismissing this week's announcement does not silently swallow next
 * week's — the classic version of this bug, where a merchant swears the bar is broken because
 * one visitor dismissed a different message in March.
 *
 * Labels arrive as props: this component must not import the message catalogue (see i18n.ts).
 */

export interface AnnouncementBarProps {
  text: string;
  link: string | null;
  /** Changes whenever the announcement's content changes. */
  signature: string;
  dismissLabel: string;
  regionLabel: string;
}

const STORAGE_KEY = 'souq.bar.dismissed';

/**
 * A one-value external store over localStorage.
 *
 * `useSyncExternalStore` rather than `useState` + `useEffect`: the dismissal lives OUTSIDE React
 * (in storage), the server snapshot is "not dismissed" so the bar is in the HTML for everyone
 * who never closed it, and there is no setState-inside-an-effect cascade on every page load.
 *
 * The value is memoised because `getSnapshot` must return a stable reference between renders —
 * reading localStorage directly on every call would make React loop.
 */
const listeners = new Set<() => void>();
let cachedValue: string | null | undefined;

function readStore(): string | null {
  if (cachedValue === undefined) {
    try {
      cachedValue = window.localStorage.getItem(STORAGE_KEY);
    } catch {
      // Storage can be denied outright (private mode, a locked-down browser). A bar that
      // reappears is a far smaller problem than a page that fails to hydrate.
      cachedValue = null;
    }
  }
  return cachedValue;
}

function writeStore(value: string): void {
  cachedValue = value;
  try {
    window.localStorage.setItem(STORAGE_KEY, value);
  } catch {
    /* see readStore */
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  // Another tab dismissing the same bar should take effect here too.
  const onStorage = () => {
    cachedValue = undefined;
    listener();
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', onStorage);
  };
}

export function AnnouncementBar({
  text,
  link,
  signature,
  dismissLabel,
  regionLabel,
}: AnnouncementBarProps) {
  const dismissedSignature = useSyncExternalStore(subscribe, readStore, () => null);

  if (dismissedSignature === signature) return null;

  return (
    <aside className="sf-bar" aria-label={regionLabel}>
      <div className="sf-shell sf-bar__inner">
        <p className="sf-bar__text">
          {link ? (
            <a href={link} rel="noopener noreferrer">
              {text}
            </a>
          ) : (
            text
          )}
        </p>
        <button
          type="button"
          className="sf-bar__close"
          onClick={() => writeStore(signature)}
          aria-label={dismissLabel}
        >
          <CloseIcon width={14} height={14} />
        </button>
      </div>
    </aside>
  );
}
