import { hashVisitor } from '@/server/crypto';
import { DEVICE_KINDS, type DeviceKind } from './types';

/**
 * The privacy core of Q20. Everything else in this folder is bookkeeping; this file is the claim.
 *
 * `visitorKey = HMAC(secret, ip + '|' + userAgent + '|' + yyyy-mm-dd)`, hex, truncated to 32
 * characters. Three properties, in the order they matter:
 *
 *   1. IT IS KEYED. A bare SHA-256 of an IPv4 address is not anonymisation — the whole address
 *      space is 2^32 values, which is minutes of brute force on a laptop. `hashVisitor` is an
 *      HMAC under `ENCRYPTION_KEY` (see src/server/crypto.ts), so reversing it requires the
 *      secret, not patience.
 *   2. IT IS SALTED WITH THE DATE. Today's key for a visitor and tomorrow's key for the same
 *      visitor are unrelated values, so no query can follow one person across days. That is the
 *      whole difference between a COUNTING DEVICE and an IDENTIFIER, and it is why `visitors` in
 *      `AnalyticsDaily` is computed at rollup time and can never be recomputed later — a
 *      thirty-day distinct count is not merely expensive here, it is unrepresentable. Deliberate.
 *   3. THE INPUTS ARE DISCARDED. The IP and the user agent exist for the length of this function
 *      call. Neither is stored, logged, or returned. `analytics_events` has no column for either.
 *
 * The IP itself is resolved by `getClientIp()` and nothing else (invariant 9) — the callers do
 * that and pass the result in, so this file has no opinion about headers and cannot be the place
 * where `X-Forwarded-For` sneaks back in.
 *
 * WHAT WAS REJECTED. A cookie-based visitor id would be stabler and cheaper, and is exactly what
 * this design refuses: a durable per-visitor identifier on a site facing Israeli consumers needs a
 * consent story of its own, and the merchant's question ("how many people, which sections") does
 * not need one. A daily HMAC answers it and expires by construction.
 */

/** 16 bytes of the digest, in hex. Collisions inside one tenant-day are noise in a count. */
const KEY_LENGTH = 32;

export interface VisitorKeyInput {
  /** From `getClientIp()`. Null when nothing trustworthy was available — see below. */
  ip: string | null;
  userAgent: string | null;
  /** Injected by tests. Production always salts against the real clock. */
  now?: Date;
}

/**
 * `yyyy-mm-dd` in UTC.
 *
 * UTC, not Asia/Jerusalem, and the choice is load-bearing rather than lazy: the rollup groups raw
 * rows by a UTC day range, so a key salted with a local date would rotate three hours before the
 * boundary the rollup counts to. One visitor would then appear as two on every evening of the
 * year. The merchant-facing REPORT is a different question — it prints dates, and a date is
 * displayed in the shop's own timezone — but the salt and the grouping have to agree, and they do.
 */
export function daySalt(now: Date): string {
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  const day = String(now.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * The counting key for one visitor on one day.
 *
 * `hashVisitor` returns base64url; this converts to hex because that is what Q20 and the
 * `analytics_events.visitor_key` docblock specify, and because hex is what a person debugging a
 * distinct count can compare by eye without wondering about `-` versus `+`. Converting is cheaper
 * and safer than adding a second HMAC helper to `src/server/crypto.ts` beside the one that
 * already exists — one keyed-hash implementation on the platform, not two.
 *
 * A NULL IP still produces a key. `getClientIp()` returns null rather than a guess when nothing is
 * trustworthy, and the honest reading of that is "one unknown visitor", not "no visitor": dropping
 * the event would silently under-count a whole class of traffic (a health check, a misconfigured
 * proxy) and, worse, would make the number quietly wrong rather than visibly odd. Every such
 * request collapses onto ONE key per day, so it cannot inflate `visitors` either.
 *
 * `'analytics'` prefixes the hashed value on purpose. `hashVisitor` is also what
 * `src/app/site/_data/consent.ts` uses for `Consent.visitorHash`, under the same HMAC domain — and
 * that value is deliberately salted per TENANT and per MONTH. Without a distinguishing prefix a
 * future change to either input string could make the two comparable, which would let a consent
 * log be joined to an event stream. The prefix makes them different values by construction.
 */
export function visitorKey(input: VisitorKeyInput): string {
  const now = input.now ?? new Date();
  const value = `analytics:${input.ip ?? 'unknown'}|${input.userAgent ?? ''}|${daySalt(now)}`;
  return Buffer.from(hashVisitor(value), 'base64url').toString('hex').slice(0, KEY_LENGTH);
}

/**
 * COARSE on purpose: two buckets, from one substring test.
 *
 * This is the only property of the user agent that survives the request, and the reason it may
 * survive at all is that it carries roughly one bit. A merchant asks "are my customers on their
 * phones?" and gets an answer; nobody gets a browser-version histogram sitting next to a visitor
 * key, which is how a coarse bucket turns into a fingerprint one field at a time.
 *
 * An absent or unrecognised user agent reads as `desktop`. That is a default, not a detection: on
 * a Palestinian storefront the mobile share is the high one, so guessing `mobile` for junk traffic
 * would flatter the number the merchant is most likely to act on.
 *
 * Modern iPad Safari reports a desktop user agent and is therefore counted as one. Known, and not
 * worth a second regex — the alternative is touch-point sniffing on the client, which is a
 * fingerprinting signal in its own right.
 */
export function deviceKindFrom(userAgent: string | null): DeviceKind {
  if (!userAgent) return 'desktop';
  return /Mobi|Android|iPhone|iPod|Windows Phone|IEMobile|BlackBerry/i.test(userAgent)
    ? 'mobile'
    : 'desktop';
}

export function isDeviceKind(value: unknown): value is DeviceKind {
  return typeof value === 'string' && (DEVICE_KINDS as readonly string[]).includes(value);
}
