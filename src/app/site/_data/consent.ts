import { hashVisitor } from '@/server/crypto';

/**
 * Visitor consent — the gate in front of all tracking.
 *
 * Two records, on purpose:
 *   - a COOKIE, which is what the server reads on the next request to decide whether the Umami
 *     tag exists in the HTML at all. It is HttpOnly, because nothing on the page has any
 *     business reading or forging it;
 *   - a `Consent` ROW per tenant with a timestamp, which is the compliance artefact
 *     (CLAUDE.md: "consent records stored per tenant with timestamp") and what Phase 6's
 *     consents log reviews.
 *
 * The cookie alone would be unauditable; the row alone would cost a database read on every
 * page view of every storefront. Together they are one write per decision and zero reads per
 * page.
 */

export const CONSENT_COOKIE = 'souq_consent';

/** Six months. Long enough not to nag, short enough to be a renewed decision rather than a life sentence. */
export const CONSENT_MAX_AGE_SECONDS = 60 * 60 * 24 * 180;

export type ConsentValue = 'granted' | 'denied';

export interface ConsentState {
  /** Has the visitor answered at all? Unanswered means the banner is shown. */
  answered: boolean;
  granted: boolean;
}

export function readConsentCookie(value: string | undefined): ConsentState {
  if (value === 'granted') return { answered: true, granted: true };
  if (value === 'denied') return { answered: true, granted: false };
  return { answered: false, granted: false };
}

/**
 * A rotating per-visitor hash — never a raw identifier, and never a bare hash of one.
 *
 * `hashVisitor` is an HMAC under the platform's encryption key: a plain SHA-256 of an IPv4
 * address is not anonymisation, because the whole address space is minutes of brute force. The
 * MONTH is mixed in so the same visitor is a different value next month, which is what makes
 * the word "rotating" true rather than decorative.
 *
 * Scoped per tenant too: one merchant's consent log must not be joinable against another's.
 */
export function visitorHash(input: {
  tenantId: string;
  ip: string | null;
  userAgent: string | null;
  now?: Date;
}): string {
  const now = input.now ?? new Date();
  const month = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  return hashVisitor(`${input.tenantId}:${input.ip ?? 'unknown'}:${input.userAgent ?? ''}:${month}`);
}
