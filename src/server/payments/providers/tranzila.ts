import { createScaffoldedAdapter } from './scaffold';
import type { GatewayAdapter } from '../types';

/**
 * Tranzila — SCAFFOLDED, not activated (the Launch Gate).
 *
 * `terminalName` is Tranzila's account identifier, `apiKey`/`apiPassword` the API credential pair,
 * and `webhookSecret` signs the settlement notice.
 *
 * The signature header below is a PLACEHOLDER — confirm it against Tranzila's documentation at
 * activation. See `providers/scaffold.ts`.
 */
export const tranzilaAdapter: GatewayAdapter = createScaffoldedAdapter({
  provider: 'tranzila',
  credentialFields: ['terminalName', 'apiKey', 'apiPassword', 'webhookSecret'],
  signingSecretField: 'webhookSecret',
  signatureHeader: 'x-tranzila-signature',
});
