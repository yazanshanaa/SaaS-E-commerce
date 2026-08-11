import { manualAdapter } from './providers/manual';
import { meshulamAdapter } from './providers/meshulam';
import { paypalAdapter } from './providers/paypal';
import { tranzilaAdapter } from './providers/tranzila';
import {
  GATEWAY_PROVIDERS,
  UnknownGatewayProviderError,
  isGatewayProvider,
  type GatewayAdapter,
  type GatewayProvider,
} from './types';

/**
 * provider -> adapter. A plain table, resolved synchronously.
 *
 * Deliberately NOT the lazy-import registry `src/server/queues.ts` uses. That pattern exists so
 * parallel tracks can add a processor without editing a shared file; there are no parallel tracks
 * here, and an adapter is needed inside a request path where an await on a dynamic import buys
 * nothing. A static table also means `pnpm typecheck` proves every provider in the enum has an
 * implementation — a `Record<GatewayProvider, …>` with a missing key is a compile error, which is
 * the property that matters when the enum is also a database value.
 */
const ADAPTERS: Record<GatewayProvider, GatewayAdapter> = {
  manual: manualAdapter,
  meshulam: meshulamAdapter,
  tranzila: tranzilaAdapter,
  paypal: paypalAdapter,
};

export function adapterFor(provider: GatewayProvider): GatewayAdapter {
  return ADAPTERS[provider];
}

/** Resolve an untrusted string. Throws rather than falling back — there is no default provider. */
export function adapterForValue(value: string): GatewayAdapter {
  if (!isGatewayProvider(value)) throw new UnknownGatewayProviderError(value);
  return ADAPTERS[value];
}

export function listAdapters(): readonly GatewayAdapter[] {
  return GATEWAY_PROVIDERS.map((provider) => ADAPTERS[provider]);
}

/** Can this provider take money today? The admin panel refuses to enable one that cannot. */
export function isActivated(provider: GatewayProvider): boolean {
  return ADAPTERS[provider].status === 'active';
}
