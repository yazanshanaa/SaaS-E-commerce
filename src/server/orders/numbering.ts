import type { TenantTx } from '@/server/db';

/**
 * Per-tenant order numbers, allocated from `TenantCounter` — never from `max()+1`.
 *
 * The counter's primary key is `@@id([tenantId, key])`, so there is exactly one row per tenant and
 * that row IS the serialisation point.
 */
export const ORDER_NUMBER_KEY = 'order_number';

/**
 * Allocate the next order number inside the caller's transaction.
 *
 * ONE STATEMENT, and that is the whole argument. `INSERT … ON CONFLICT DO UPDATE` takes a
 * row-level exclusive lock on the counter row before it computes the new value and holds it until
 * the transaction ends. Two concurrent checkouts for the same tenant therefore serialise on that
 * row: the second blocks *inside* the statement, and when the first commits, Postgres re-checks
 * the conflict target and the waiter increments the COMMITTED value rather than a stale snapshot.
 *
 * `SELECT max(number)+1` and `SELECT … then UPDATE` both read outside that lock, so under REPEATABLE
 * READ they either produce a duplicate that violates `@@unique([tenantId, number])` — a 500 on a
 * customer's checkout — or, under READ COMMITTED, two orders racing for the same number where one
 * simply loses. Neither is acceptable for a number a merchant reads out over the phone.
 *
 * `RETURNING` avoids a second read. The lock is on the tenant's OWN row, so tenants never wait on
 * each other.
 *
 * Gap-free up to rollbacks: a rolled-back checkout takes its `Order` with it, so a gap can only
 * ever mean "no order exists with that number", never "an order is missing".
 */
export async function allocateOrderNumber(tx: TenantTx, tenantId: string): Promise<number> {
  const rows = await tx.$queryRaw<Array<{ value: number }>>`
    INSERT INTO "tenant_counters" ("tenant_id", "key", "value", "updated_at")
    VALUES (${tenantId}, ${ORDER_NUMBER_KEY}, 1, now())
    ON CONFLICT ("tenant_id", "key")
    DO UPDATE SET "value" = "tenant_counters"."value" + 1, "updated_at" = now()
    RETURNING "value"
  `;

  const value = rows[0]?.value;
  if (value === undefined) {
    // Unreachable while a tenant context is set: an INSERT refused by the RLS WITH CHECK raises
    // rather than returning nothing. If this ever fires, the transaction had no `app.tenant_id`.
    throw new Error(`Order number allocation returned no row for tenant ${tenantId}.`);
  }

  return Number(value);
}
