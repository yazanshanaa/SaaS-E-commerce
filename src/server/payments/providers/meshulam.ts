import { createScaffoldedAdapter } from './scaffold';
import type { GatewayAdapter } from '../types';

/**
 * Meshulam — SCAFFOLDED, not activated (the Launch Gate).
 *
 * Field names come from Meshulam's own vocabulary so the encrypted blob written today is the blob
 * activation reads: `apiKey` + `userId` identify the account, `pageCode` selects the payment page,
 * and `webhookSecret` is what a settlement notice is signed with.
 *
 * The signature header below is a PLACEHOLDER and must be confirmed against Meshulam's
 * documentation on the day of activation — see `providers/scaffold.ts`.
 */
export const meshulamAdapter: GatewayAdapter = createScaffoldedAdapter({
  provider: 'meshulam',
  credentialFields: ['apiKey', 'userId', 'pageCode', 'webhookSecret'],
  signingSecretField: 'webhookSecret',
  signatureHeader: 'x-meshulam-signature',
});
