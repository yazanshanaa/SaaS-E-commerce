/** A tenant id that resolves to nothing — a purged tenant, or a bad id in a stale job. */
export class TenantNotFoundError extends Error {
  constructor(readonly tenantId: string) {
    super(`Tenant not found: ${tenantId}`);
    this.name = 'TenantNotFoundError';
  }
}

/**
 * Thrown by withTenantTxn for a tenant marked `purging`.
 *
 * This is the fail-closed half of the purge: a job dequeued a moment before the sweep started
 * dies here instead of writing fresh objects into a prefix we just deleted. Since the Tenant
 * row is about to disappear, anything written after the sweep would be unreachable forever —
 * a leak with no owner and no way to find it.
 */
export class TenantPurgingError extends Error {
  constructor(readonly tenantId: string) {
    super(`Tenant ${tenantId} is being purged; refusing further work.`);
    this.name = 'TenantPurgingError';
  }
}
