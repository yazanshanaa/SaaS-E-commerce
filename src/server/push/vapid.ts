import webpush from 'web-push';
import { getEnv } from '@/env';
import { logger } from '@/server/logger';

/**
 * VAPID — the key pair that identifies this platform to every push service.
 *
 * Read from env and NEVER from a build-time constant. `.env.example` carries a
 * `NEXT_PUBLIC_VAPID_PUBLIC_KEY` slot that nothing reads, deliberately: the storefront is
 * server-rendered, so the public key reaches the subscribe button as a prop. A `NEXT_PUBLIC_*`
 * variable is inlined at BUILD time, which would mean rotating the pair needs a rebuild rather
 * than a restart — and a stale baked key produces subscriptions signed for a key the sender no
 * longer holds, which fail at delivery with no clue as to why.
 *
 * Unconfigured is a first-class state, not an error. A development checkout and the e2e stack
 * both run with no keys, and the correct behaviour there is that the subscribe prompt never
 * appears — offering a visitor a button that cannot work is worse than offering nothing.
 */

export interface VapidConfig {
  publicKey: string;
  privateKey: string;
  /** `mailto:` or `https:` — RFC 8292 requires a way to contact us when deliveries fail. */
  subject: string;
}

let configured: VapidConfig | null | undefined;

function build(): VapidConfig | null {
  const env = getEnv();
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return null;

  // A missing subject falls back to the platform's own sending address rather than refusing:
  // the pair is what makes push work, and the contact is what makes it polite.
  const subject = env.VAPID_SUBJECT?.trim() || `mailto:${env.MAIL_FROM}`;

  return {
    publicKey: env.VAPID_PUBLIC_KEY.trim(),
    privateKey: env.VAPID_PRIVATE_KEY.trim(),
    subject,
  };
}

/**
 * The config, with `web-push` already told about it.
 *
 * `setVapidDetails` validates the pair and throws on a malformed one — which is a configuration
 * error, not a request error, so it is caught, logged once and turned into "push is not
 * configured". A storefront must not 500 because someone pasted a truncated key into `.env`.
 */
export function vapidConfig(): VapidConfig | null {
  if (configured !== undefined) return configured;

  const built = build();
  if (!built) {
    configured = null;
    return null;
  }

  try {
    webpush.setVapidDetails(built.subject, built.publicKey, built.privateKey);
    configured = built;
  } catch (error) {
    logger().error(
      { error: (error as Error).message },
      'VAPID keys are present but invalid; push is disabled',
    );
    configured = null;
  }

  return configured;
}

/** The value the storefront hands to `pushManager.subscribe`. Null when push cannot work. */
export function pushPublicKey(): string | null {
  return vapidConfig()?.publicKey ?? null;
}

export function isPushConfigured(): boolean {
  return vapidConfig() !== null;
}

/** Test-only: forget the memoised config after mutating process.env. */
export function resetVapidCache(): void {
  configured = undefined;
}
