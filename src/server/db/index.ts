/**
 * The isolation boundary. Nothing outside this folder may import `@prisma/client` directly
 * (enforced by eslint.config.mjs) — everything goes through a scoped client or withTenantTxn.
 */
export { webClient, systemClient, disconnectAll } from './client';
export { tenantDb, superAdminDb, publicDb, authDb, type ScopedDb } from './scoped';
export { withTenantTxn, withSystemTxn, type TenantTx, type WithTenantTxnOptions } from './with-tenant-txn';
export {
  ACTOR_ROLES,
  type Actor,
  type ActorRole,
  verifiedActor,
  isSuperAdmin,
  PUBLIC_ACTOR,
  SYSTEM_ACTOR,
} from './actor';
export { TenantNotFoundError, TenantPurgingError } from './errors';
