import { createScaffoldedAdapter } from './scaffold';
import type { GatewayAdapter } from '../types';

/**
 * PayPal — SCAFFOLDED, not activated (the Launch Gate).
 *
 * The V1 intent is PayPal LINKS rather than a full checkout integration, so the credential set is
 * the ordinary OAuth pair plus the webhook identifier PayPal signs notifications against.
 *
 * PayPal does not sign with a shared HMAC secret in production — it signs with a certificate chain
 * — so the verification inherited here is a placeholder in a stronger sense than the other two:
 * activating PayPal means REPLACING `verifyCallback`, not merely confirming a header name. Recorded
 * in `docs/DECISIONS.md`.
 */
export const paypalAdapter: GatewayAdapter = createScaffoldedAdapter({
  provider: 'paypal',
  credentialFields: ['clientId', 'clientSecret', 'webhookId', 'webhookSecret'],
  signingSecretField: 'webhookSecret',
  signatureHeader: 'paypal-transmission-sig',
});
