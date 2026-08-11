/**
 * The payment gateway layer (Phase 5).
 *
 * One barrel so every caller imports from `@/server/payments` and nothing reaches into
 * `providers/` — the adapters are an implementation detail of `registry.ts`, and a route that
 * imported one directly would be one refactor away from bypassing the activation check.
 */

export {
  GATEWAY_PROVIDERS,
  GatewayNotActivatedError,
  UnknownGatewayProviderError,
  isGatewayProvider,
  type CallbackRejection,
  type CallbackResult,
  type GatewayAdapter,
  type GatewayCredentials,
  type GatewayProvider,
  type GatewayStatus,
  type PaymentLink,
  type PaymentLinkRequest,
  type RawCallback,
  type RefundRequest,
  type RefundResult,
} from './types';

export { adapterFor, adapterForValue, isActivated, listAdapters } from './registry';

export {
  gatewayReadiness,
  instructionsFrom,
  loadCredentials,
  readEnabledGateway,
  readEnabledGatewayInTx,
  readGatewayConfigs,
  setGatewayEnabled,
  writeGatewayConfig,
  type GatewayReadiness,
  type GatewayState,
  type WriteGatewayConfigInput,
} from './config';
