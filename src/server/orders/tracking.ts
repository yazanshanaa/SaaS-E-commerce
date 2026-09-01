import type { TenantTx } from '@/server/db';
import { shortId } from '@/server/crypto';

/**
 * Public order tracking codes (Phase 8, item 5 of the change plan): 8+ cryptographically random
 * characters, NEVER sequential — `shortId()` is `crypto.randomBytes` under a 32-character
 * alphabet that already excludes visually-ambiguous characters (no `0`/`o`, no `1`/`l`/`i`), the
 * same generator B3 uses for demo slugs. Ten characters here rather than B3's default six: a
 * tracking code is a bearer credential to one order (paired with the last 4 digits of the
 * order's own phone — src/server/orders/self-service.ts) rather than a human-quoted slug
 * suffix, so the guessing space matters more.
 *
 * Unique PER TENANT (`@@unique([tenantId, trackingCode])`), not globally: the public tracking
 * route already resolves the tenant from the hostname before this is ever queried, so collision
 * checking only ever needs to ask "does THIS tenant already have this code" — a query RLS
 * already scopes correctly.
 */

const TRACKING_CODE_LENGTH = 10;
const MAX_ATTEMPTS = 5;

export async function generateTrackingCode(tx: TenantTx, tenantId: string): Promise<string> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const candidate = shortId(TRACKING_CODE_LENGTH);
    const existing = await tx.order.findFirst({
      where: { tenantId, trackingCode: candidate },
      select: { id: true },
    });
    if (!existing) return candidate;
  }

  // Astronomically unlikely (32^10 possibilities per tenant) — if it ever fires, something
  // upstream is generating non-random codes, not that the space is actually exhausted.
  throw new Error(`Could not allocate a unique tracking code for tenant ${tenantId} after ${MAX_ATTEMPTS} attempts.`);
}
