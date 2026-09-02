import { seal, unseal } from '@/server/crypto';
import type { ScopedDb, TenantTx } from '@/server/db';
import { logger } from '@/server/logger';
import { adapterFor } from './registry';
import {
  isGatewayProvider,
  type GatewayCredentials,
  type GatewayProvider,
  type GatewayStatus,
} from './types';

/**
 * `gateway_configs` — the only module in the platform that holds a plaintext provider key.
 *
 * Credentials are sealed with AES-256-GCM under `ENCRYPTION_KEY` (`src/server/crypto.ts`) and
 * stored as three columns. They leave this file in exactly one direction: `loadCredentials`, whose
 * one legitimate caller is an adapter about to sign a request. THEY ARE NEVER PART OF A RETURN
 * TYPE ANYTHING ELSE SEES — `GatewayState` carries `hasCredentials: boolean`, and every admin
 * screen, audit row, event payload and log line is built from that.
 *
 * The row is per `[tenantId, provider]`, and at most one provider is `enabled` at a time —
 * `setGatewayEnabled` disables the others FIRST in the same transaction, and since the 2026-08-20
 * pre-launch migration a PARTIAL unique index (`gateway_configs_one_enabled_per_tenant`, on
 * (tenant_id) WHERE enabled) is the database backstop the Phase 5 carry-forward asked for. The
 * disable-then-enable ORDER in `setGatewayEnabled` is now load-bearing: uniques are checked per
 * statement, so enabling before disabling would trip the index mid-transaction. The read path
 * still resolves ONE row (`findFirst({ where: { enabled: true } })`), so even a state the index
 * cannot exist in degrades to "the first one wins", never to a checkout with two gateways.
 */

export interface GatewayState {
  provider: GatewayProvider;
  status: GatewayStatus;
  enabled: boolean;
  /** Whether a sealed credential blob exists. NEVER the blob, never a field of it. */
  hasCredentials: boolean;
  /** Merchant-authored Arabic shown at checkout on the manual adapter. Not a secret. */
  instructions: string | null;
}

/**
 * Why checkout is or is not live, as one value.
 *
 * A single enum rather than a pile of booleans because both surfaces print ONE Arabic sentence
 * from it — the admin's «ليش ما بتشتغل» line and the merchant's own — and two surfaces deriving
 * the same sentence from three flags is how they end up disagreeing.
 */
export type GatewayReadiness =
  | 'feature_off'
  | 'no_provider'
  | 'no_credentials'
  | 'not_activated'
  | 'ready';

interface ConfigRow {
  provider: string;
  enabled: boolean;
  credentialsCipher: string | null;
  config: unknown;
}

const ROW_SELECT = {
  provider: true,
  enabled: true,
  credentialsCipher: true,
  config: true,
} as const;

/**
 * The merchant's payment instructions, read out of the row's `config` JSON.
 *
 * `config Json?` is a Phase 1 column with no shape declared, so it is read defensively: anything
 * that is not a string becomes null rather than reaching the storefront as `[object Object]`.
 */
export function instructionsFrom(config: unknown): string | null {
  if (config === null || typeof config !== 'object') return null;
  const value = (config as Record<string, unknown>).instructions;
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function toState(row: ConfigRow | null): GatewayState | null {
  if (!row || !isGatewayProvider(row.provider)) return null;

  return {
    provider: row.provider,
    status: adapterFor(row.provider).status,
    enabled: row.enabled,
    hasCredentials: row.credentialsCipher !== null,
    instructions: instructionsFrom(row.config),
  };
}

/**
 * The tenant's ACTIVE gateway, or null.
 *
 * "Active" means an enabled row. A tenant whose credentials are saved but whose gateway is switched
 * off resolves to null here on purpose: the storefront must not render a checkout for it, and the
 * admin panel reads `readGatewayConfigs` instead when it wants to show what is stored.
 */
export async function readEnabledGateway(
  db: ScopedDb,
  tenantId: string,
): Promise<GatewayState | null> {
  const row = await db.gatewayConfig.findFirst({
    where: { tenantId, enabled: true },
    select: ROW_SELECT,
    orderBy: { createdAt: 'asc' },
  });

  return toState(row);
}

/** The same read inside a caller's transaction — the storefront context and the purge both need it. */
export async function readEnabledGatewayInTx(
  tx: TenantTx,
  tenantId: string,
): Promise<GatewayState | null> {
  const row = await tx.gatewayConfig.findFirst({
    where: { tenantId, enabled: true },
    select: ROW_SELECT,
    orderBy: { createdAt: 'asc' },
  });

  return toState(row);
}

/** Every stored provider row for a tenant, enabled or not. The admin panel's list. */
export async function readGatewayConfigs(
  db: ScopedDb,
  tenantId: string,
): Promise<GatewayState[]> {
  const rows = await db.gatewayConfig.findMany({
    where: { tenantId },
    select: ROW_SELECT,
    orderBy: { createdAt: 'asc' },
  });

  return rows.map(toState).filter((state): state is GatewayState => state !== null);
}

/**
 * Unseal a provider's credentials.
 *
 * The ONLY door out. Returns null when nothing is stored or when the blob cannot be opened — a
 * rotated `ENCRYPTION_KEY` is the realistic cause, and the honest answer is "no credentials",
 * which stops the gateway rather than crashing a checkout with a decryption error.
 */
export async function loadCredentials(
  db: ScopedDb,
  tenantId: string,
  provider: GatewayProvider,
): Promise<GatewayCredentials | null> {
  const row = await db.gatewayConfig.findUnique({
    where: { tenantId_provider: { tenantId, provider } },
    select: { credentialsCipher: true, credentialsIv: true, credentialsTag: true },
  });

  if (!row?.credentialsCipher || !row.credentialsIv || !row.credentialsTag) return null;

  try {
    const parsed: unknown = JSON.parse(
      unseal({ cipher: row.credentialsCipher, iv: row.credentialsIv, tag: row.credentialsTag }),
    );

    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

    const credentials: Record<string, string> = {};
    for (const [field, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'string') credentials[field] = value;
    }

    return credentials;
  } catch {
    // Never log the cipher, the IV or the tag — the identity of the row is enough to act on.
    logger().error({ tenantId, provider }, 'gateway credentials could not be opened');
    return null;
  }
}

export interface WriteGatewayConfigInput {
  tenantId: string;
  provider: GatewayProvider;
  /**
   * Sealed here. OMITTED, or an empty object, leaves the stored blob alone — the admin form never
   * re-displays a saved credential, so a blank field is the only way to say "unchanged".
   */
  credentials?: Record<string, string>;
  /** `undefined` leaves it alone; `null` clears it. */
  instructions?: string | null;
}

/**
 * Create or update a provider row. Credentials are MERGED with what is stored, field by field, so
 * an admin correcting one key does not have to retype the other three.
 */
export async function writeGatewayConfig(
  tx: TenantTx,
  input: WriteGatewayConfigInput,
): Promise<{ hasCredentials: boolean; fields: string[] }> {
  const adapter = adapterFor(input.provider);

  const existing = await tx.gatewayConfig.findUnique({
    where: { tenantId_provider: { tenantId: input.tenantId, provider: input.provider } },
    select: { credentialsCipher: true, credentialsIv: true, credentialsTag: true, config: true },
  });

  let stored: Record<string, string> = {};
  if (existing?.credentialsCipher && existing.credentialsIv && existing.credentialsTag) {
    try {
      const parsed: unknown = JSON.parse(
        unseal({
          cipher: existing.credentialsCipher,
          iv: existing.credentialsIv,
          tag: existing.credentialsTag,
        }),
      );
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const [field, value] of Object.entries(parsed as Record<string, unknown>)) {
          if (typeof value === 'string') stored[field] = value;
        }
      }
    } catch {
      // An unopenable blob is replaced wholesale rather than merged into — merging into garbage
      // would keep it forever.
      stored = {};
    }
  }

  /**
   * Only fields the ADAPTER declares are kept. An extra key in the form body is dropped rather
   * than sealed, so a caller cannot use this row as arbitrary encrypted storage.
   */
  for (const field of adapter.credentialFields) {
    const supplied = input.credentials?.[field];
    if (typeof supplied === 'string' && supplied.trim() !== '') {
      stored[field] = supplied.trim();
    }
  }

  for (const field of Object.keys(stored)) {
    if (!adapter.credentialFields.includes(field)) delete stored[field];
  }

  const fields = Object.keys(stored).sort();
  const sealed = fields.length > 0 ? seal(JSON.stringify(stored)) : null;

  const nextInstructions =
    input.instructions === undefined
      ? instructionsFrom(existing?.config ?? null)
      : input.instructions;

  const config = nextInstructions === null ? {} : { instructions: nextInstructions };

  await tx.gatewayConfig.upsert({
    where: { tenantId_provider: { tenantId: input.tenantId, provider: input.provider } },
    create: {
      tenantId: input.tenantId,
      provider: input.provider,
      enabled: false,
      credentialsCipher: sealed?.cipher ?? null,
      credentialsIv: sealed?.iv ?? null,
      credentialsTag: sealed?.tag ?? null,
      config,
    },
    update: {
      credentialsCipher: sealed?.cipher ?? null,
      credentialsIv: sealed?.iv ?? null,
      credentialsTag: sealed?.tag ?? null,
      config,
    },
  });

  return { hasCredentials: sealed !== null, fields };
}

/**
 * Flip a provider on or off for a tenant.
 *
 * Enabling one DISABLES every other provider on the same tenant in the same statement, so the
 * "at most one enabled" rule cannot be broken by two admins clicking at once — the second write
 * simply turns the first one off.
 */
export async function setGatewayEnabled(
  tx: TenantTx,
  tenantId: string,
  provider: GatewayProvider,
  enabled: boolean,
): Promise<void> {
  if (enabled) {
    await tx.gatewayConfig.updateMany({
      where: { tenantId, provider: { not: provider } },
      data: { enabled: false },
    });
  }

  await tx.gatewayConfig.update({
    where: { tenantId_provider: { tenantId, provider } },
    data: { enabled },
  });
}

/**
 * Why checkout is or is not live. PURE — no database, no i18n — so both surfaces derive the same
 * answer and a unit test can enumerate every branch.
 *
 * The order of the checks is the order a human would ask them: is the feature even sold, has a
 * provider been chosen, is it a provider that can take money, are its keys in place.
 */
export function gatewayReadiness(input: {
  featureOn: boolean;
  state: GatewayState | null;
}): GatewayReadiness {
  if (!input.featureOn) return 'feature_off';
  if (!input.state) return 'no_provider';
  if (input.state.status !== 'active') return 'not_activated';
  if (!input.state.hasCredentials && adapterFor(input.state.provider).credentialFields.length > 0) {
    return 'no_credentials';
  }
  return 'ready';
}
