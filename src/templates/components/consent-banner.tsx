'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

/**
 * The consent banner — the gate in front of ALL tracking.
 *
 * The important part of this component is what it does NOT do: it does not load anything, it
 * does not set an analytics flag that a script then reads, and there is no script on the page
 * to read one. Nothing third-party is in the HTML until the SERVER has seen a stored consent
 * record and re-rendered. That is why "a first visit issues zero tracking requests" is testable
 * against real network traffic instead of against a promise.
 *
 * It is rendered only when the tenant HAS analytics available and the visitor has not answered
 * yet. An أساسي site never shows it, because asking permission for something that can never
 * happen is a dark pattern in the other direction.
 */

export interface ConsentBannerProps {
  labels: {
    title: string;
    body: string;
    accept: string;
    decline: string;
    region: string;
    more: string;
  };
  privacyHref: string;
}

export function ConsentBanner({ labels, privacyHref }: ConsentBannerProps) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [answered, setAnswered] = useState(false);

  async function answer(granted: boolean) {
    setBusy(true);
    try {
      await fetch('/api/storefront/consent', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ granted }),
      });
      setAnswered(true);
      // The server decides whether a script tag exists at all, so the page has to be re-rendered
      // by the server for an acceptance to take effect. A client-side script injection would
      // move that decision to where it cannot be audited.
      router.refresh();
    } catch {
      // A failed write must not trap the visitor behind a banner they cannot dismiss.
      setAnswered(true);
    } finally {
      setBusy(false);
    }
  }

  if (answered) return null;

  return (
    <div className="sf-consent" role="region" aria-label={labels.region}>
      <div className="sf-consent__inner">
        <div className="sf-consent__copy">
          <p className="sf-consent__title">{labels.title}</p>
          <p className="sf-consent__body">
            {labels.body}{' '}
            <a href={privacyHref} className="sf-consent__link">
              {labels.more}
            </a>
          </p>
        </div>
        {/*
          THE PRIMARY COMES FIRST, IN THE DOM. Every other action pair on a storefront leads with the
          filled button — the hero, the contact block, the map — and this bar led with the ghost one,
          so «موافق» landed second in reading order while «اطلب عبر واتساب» lands first everywhere
          else. A visitor should not have to re-read which button is which because one component
          disagrees with the page.

          Fixed in the MARKUP rather than with `flex-direction: row-reverse`, which was tried and is
          the wrong tool twice over: it would have left the tab order reversed against the visual
          order — a keyboard user tabbing to the first button would reach «رفض» — and the container
          is `.sf-actions`, shared with every other action row on the storefront, so a rule here
          could not have been scoped to the consent bar without a class that does not exist.
        */}
        <div className="sf-actions">
          <button
            type="button"
            className="sf-btn"
            onClick={() => void answer(true)}
            disabled={busy}
          >
            {labels.accept}
          </button>
          <button
            type="button"
            className="sf-btn sf-btn--ghost"
            onClick={() => void answer(false)}
            disabled={busy}
          >
            {labels.decline}
          </button>
        </div>
      </div>
    </div>
  );
}
