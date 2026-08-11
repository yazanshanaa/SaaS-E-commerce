import { withTenantTxn } from '@/server/db';
import { can } from '@/server/entitlements';
import { gatewayConfigSchema } from '@/server/orders';
import {
  adapterFor,
  gatewayReadiness,
  isGatewayProvider,
  listAdapters,
  readEnabledGateway,
  readGatewayConfigs,
  setGatewayEnabled,
  writeGatewayConfig,
  type GatewayProvider,
  type GatewayReadiness,
  type GatewayState,
  type GatewayStatus,
} from '@/server/payments';
import { requestStorefrontRevalidation } from '@/server/revalidation';
import { auditTenantAction } from './audit';
import type { AdminContext } from './context';
import { failure, invalid, type ActionState } from './validation';

/**
 * The super admin's one-click gateway enablement (docs/PHASES.md Phase 5).
 *
 * WHY THIS LIVES ON THE ADMIN SIDE AND NOT IN THE MERCHANT DASHBOARD: a provider key is a
 * commercial credential issued to a registered entity, obtained during onboarding over the phone,
 * and typing it wrong takes a shop's checkout down. The merchant owns the SELLING SWITCH and the
 * payment instructions their customer reads; the platform owns the provider and its keys.
 *
 * Three refusals, all server-side and all with an Arabic reason:
 *   - `payment_gateway` is off on the account            -> `admin:errors.gatewayFeatureOff`
 *   - the provider is scaffolded, not activated          -> `admin:errors.gatewayNotActivated`
 *   - the provider string is not one we know             -> `admin:errors.unknownProvider`
 *
 * The feature check is re-asked HERE rather than trusted from the page that rendered the form:
 * the account page and this action are separated by however long the operator left the tab open,
 * and the feature matrix on the same screen can flip a toggle in between.
 *
 * NO CREDENTIAL VALUE EVER LEAVES THIS MODULE. `saveGatewayCredentials` hands plaintext straight
 * to `writeGatewayConfig`, which seals it; the audit row records the FIELD NAMES and a boolean,
 * and `AccountGatewayView` has no field a value could hide in.
 */

export interface GatewayProviderOption {
  provider: GatewayProvider;
  status: GatewayStatus;
  credentialFields: readonly string[];
}

export interface AccountGatewayView {
  /** Every stored provider row, enabled or not. */
  configured: GatewayState[];
  /** The one that is switched on, or null. */
  active: GatewayState | null;
  readiness: GatewayReadiness;
  featureOn: boolean;
  providers: GatewayProviderOption[];
}

export async function getAccountGateway(
  ctx: AdminContext,
  tenantId: string,
): Promise<AccountGatewayView> {
  const [featureOn, configured, active] = await Promise.all([
    can(tenantId, 'payment_gateway'),
    readGatewayConfigs(ctx.db, tenantId),
    readEnabledGateway(ctx.db, tenantId),
  ]);

  return {
    configured,
    active,
    readiness: gatewayReadiness({ featureOn: featureOn === true, state: active }),
    featureOn: featureOn === true,
    providers: listAdapters().map((adapter) => ({
      provider: adapter.provider,
      status: adapter.status,
      credentialFields: adapter.credentialFields,
    })),
  };
}

/**
 * Store (or correct) a provider's keys.
 *
 * Saving is allowed for a SCAFFOLDED provider on purpose — the Launch Gate blocks activation, not
 * preparation, and an operator who has the Meshulam credentials in front of them today should be
 * able to put them in. What is refused is switching such a provider ON, which is the action that
 * would put a dead checkout in front of a customer.
 */
export async function saveGatewayCredentials(
  ctx: AdminContext,
  tenantId: string,
  raw: unknown,
): Promise<ActionState | null> {
  const parsed = gatewayConfigSchema.safeParse(raw);
  if (!parsed.success) return invalid(parsed.error);

  if ((await can(tenantId, 'payment_gateway')) !== true) {
    return failure('admin:errors.gatewayFeatureOff');
  }

  const before = await readGatewayConfigs(ctx.db, tenantId);
  const previous = before.find((state) => state.provider === parsed.data.provider) ?? null;

  const written = await withTenantTxn(
    tenantId,
    (tx) =>
      writeGatewayConfig(tx, {
        tenantId,
        provider: parsed.data.provider,
        credentials: parsed.data.credentials,
        instructions: parsed.data.instructions ?? null,
      }),
    { actor: ctx.actor },
  );

  await auditTenantAction(ctx, tenantId, {
    action: 'gateway.credentials_set',
    entityType: 'gateway_config',
    entityId: parsed.data.provider,
    before: { hasCredentials: previous?.hasCredentials ?? false },
    /**
     * The FIELD NAMES and a boolean — never a value, never the cipher. An audit row is read by
     * people, kept for a long time, and copied into a backup; a provider key in one is a working
     * credential in every one of those places.
     */
    after: { hasCredentials: written.hasCredentials, fields: written.fields },
  });

  // The storefront renders the merchant's payment instructions, which this call can change.
  await requestStorefrontRevalidation(tenantId);

  return null;
}

/**
 * The one-click enable/disable.
 *
 * `invalidateEntitlements` is NOT called here and that is deliberate: the gateway row is not an
 * entitlement, and the storefront reads it from the cached content unit. `requestStorefrontRevalidation`
 * is what makes the change visible, and the ENTITLEMENT half (`payment_gateway`) is resolved per
 * request outside any cache — which is why the acceptance criterion "toggling the feature
 * immediately enables or disables checkout" holds without either call.
 */
export async function setAccountGatewayEnabled(
  ctx: AdminContext,
  tenantId: string,
  provider: string,
  enabled: boolean,
): Promise<ActionState | null> {
  if (!isGatewayProvider(provider)) return failure('admin:errors.unknownProvider');

  if (enabled) {
    if ((await can(tenantId, 'payment_gateway')) !== true) {
      return failure('admin:errors.gatewayFeatureOff');
    }
    if (adapterFor(provider).status !== 'active') {
      return failure('admin:errors.gatewayNotActivated');
    }
  }

  const before = await readEnabledGateway(ctx.db, tenantId);

  const existing = await readGatewayConfigs(ctx.db, tenantId);
  if (!existing.some((state) => state.provider === provider)) {
    // Enabling a provider whose row was never created would fail deep inside an update. Refuse in
    // a sentence instead: the operator has simply not saved its settings yet.
    return failure('admin:errors.gatewayNoConfig');
  }

  await withTenantTxn(tenantId, (tx) => setGatewayEnabled(tx, tenantId, provider, enabled), {
    actor: ctx.actor,
  });

  await auditTenantAction(ctx, tenantId, {
    action: enabled ? 'gateway.enabled' : 'gateway.disabled',
    entityType: 'gateway_config',
    entityId: provider,
    before: { provider: before?.provider ?? null, enabled: before?.enabled ?? false },
    after: { provider, enabled },
  });

  await requestStorefrontRevalidation(tenantId);

  return null;
}

export type { GatewayProvider, GatewayReadiness, GatewayState, GatewayStatus };
