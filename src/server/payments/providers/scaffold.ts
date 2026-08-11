import { z } from 'zod';
import { safeEqual, signWebhookBody } from '@/server/crypto';
import {
  GatewayNotActivatedError,
  type CallbackResult,
  type GatewayAdapter,
  type GatewayCredentials,
  type GatewayProvider,
  type PaymentLink,
  type RawCallback,
} from '../types';

/**
 * The shared body of a SCAFFOLDED adapter.
 *
 * Three providers are scaffolded for the same reason (the Launch Gate: a real Israeli gateway
 * needs a registered entity), so they fail the same way and verify the same way. Writing that
 * three times would have meant three places to get the constant-time comparison wrong.
 *
 * What is REAL here, today:
 *   - the credential field names, so the admin form asks for the right things and the encrypted
 *     blob written now is the blob activation will read;
 *   - the callback verification SHAPE — read the raw bytes, HMAC them under the provider's shared
 *     secret, compare in constant time, only then parse. That order is the part people get wrong,
 *     and it is worth freezing before there is money behind it.
 *
 * What is NOT real, and is marked as such at each call site: the header name and the settlement
 * envelope. Both are provider-specific and must be re-checked against the provider's own
 * documentation on the day of activation — `docs/DECISIONS.md` carries that as an open item.
 *
 * `createPaymentLink` throws rather than returning a failure value. A scaffolded provider must be
 * unreachable from a live checkout by construction, and the admin panel already refuses to enable
 * one; this is the second layer, and it is loud on purpose.
 */

/**
 * The settlement envelope every scaffolded adapter parses.
 *
 * Deliberately minimal and provider-neutral: the four facts a settlement has to carry. Mapping a
 * provider's own field names onto it is a per-provider `transform` at activation, not a change to
 * the order service.
 */
const settlementSchema = z.object({
  orderId: z.string().min(1),
  reference: z.string().min(1),
  amountAgorot: z.number().int().nonnegative(),
  status: z.enum(['paid', 'failed', 'refunded']),
});

export interface ScaffoldOptions {
  provider: GatewayProvider;
  credentialFields: readonly string[];
  /**
   * Which credential field holds the shared secret the callback is signed with, and which request
   * header carries the signature. Both are placeholders until activation.
   */
  signingSecretField: string;
  signatureHeader: string;
}

export function createScaffoldedAdapter(options: ScaffoldOptions): GatewayAdapter {
  return {
    provider: options.provider,
    status: 'scaffolded',
    credentialFields: options.credentialFields,

    async createPaymentLink(): Promise<PaymentLink> {
      throw new GatewayNotActivatedError(options.provider);
    },

    async verifyCallback(
      raw: RawCallback,
      credentials: GatewayCredentials,
    ): Promise<CallbackResult> {
      const secret = credentials[options.signingSecretField];
      if (!secret) return { ok: false, reason: 'not_activated' };

      const presented = raw.headers.get(options.signatureHeader);
      if (!presented) return { ok: false, reason: 'bad_signature' };

      // Constant time, and over the RAW BYTES — re-serialising the parsed object would change the
      // whitespace the provider actually signed and fail every legitimate callback.
      if (!safeEqual(presented, signWebhookBody(secret, raw.body))) {
        return { ok: false, reason: 'bad_signature' };
      }

      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(raw.body);
      } catch {
        return { ok: false, reason: 'malformed' };
      }

      const settlement = settlementSchema.safeParse(parsedJson);
      if (!settlement.success) return { ok: false, reason: 'malformed' };

      return {
        ok: true,
        orderId: settlement.data.orderId,
        providerRef: settlement.data.reference,
        paidAgorot: settlement.data.amountAgorot,
        status: settlement.data.status,
      };
    },
  };
}
