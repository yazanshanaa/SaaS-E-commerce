import { getEnv } from '@/env';
import { logger } from '@/server/logger';

/**
 * Storefront revalidation, callable from ANY process.
 *
 * The problem this module exists to solve, carried out of the Group A merge:
 * `revalidateStorefront()` is `revalidateTag()`, and `revalidateTag` throws outside a
 * Next-managed context. So the documented contract — "call this after any write that changes
 * what the storefront renders" — was not callable from the queue, which is exactly where A3's
 * image pipeline finishes a variant. A merchant uploaded a photo, the variants were written,
 * and the storefront kept serving the imageless card for up to the five-minute TTL with no way
 * to shorten it.
 *
 * Two runtimes, one function:
 *   - inside the Next server (`NEXT_RUNTIME === 'nodejs'`) it drops the tag directly;
 *   - anywhere else — the worker container, a script, a cron — it POSTs to the web server's
 *     `/internal/revalidate`, which does the same drop inside a request context.
 *
 * `NEXT_RUNTIME` is the signal rather than a try/catch around `revalidateTag`, because
 * swallowing that throw would also swallow a real failure and leave a stale storefront that
 * nothing reports.
 *
 * BEST EFFORT, ALWAYS. A failed cache drop must never fail its caller: the job that produced
 * the write has already committed, and retrying it would re-run the whole processing. The five
 * minute TTL is the net underneath, so the honest failure mode is "up to five minutes stale",
 * logged — not "the upload failed".
 */

/** The header the internal endpoint authenticates on. */
export const INTERNAL_SECRET_HEADER = 'x-internal-secret';

export function internalRevalidateUrl(): string {
  const base = getEnv().INTERNAL_BASE_URL.replace(/\/+$/, '');
  return `${base}/internal/revalidate`;
}

/** In-process drop. Only legal inside the Next server. */
async function revalidateInProcess(tenantId: string): Promise<void> {
  const { revalidateStorefront } = await import('@/app/site/_data/cache');
  await revalidateStorefront(tenantId);
}

async function revalidateOverHttp(tenantId: string): Promise<void> {
  const env = getEnv();
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (env.INTERNAL_API_SECRET) headers[INTERNAL_SECRET_HEADER] = env.INTERNAL_API_SECRET;

  const response = await fetch(internalRevalidateUrl(), {
    method: 'POST',
    headers,
    body: JSON.stringify({ tenantId }),
    signal: AbortSignal.timeout(env.INTERNAL_REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`internal revalidate responded ${response.status}`);
  }
}

/**
 * Drop a tenant's storefront cache from wherever you are.
 *
 * Never throws. See the module comment: the caller has already committed.
 */
export async function requestStorefrontRevalidation(tenantId: string): Promise<boolean> {
  try {
    if (process.env.NEXT_RUNTIME === 'nodejs') {
      await revalidateInProcess(tenantId);
    } else {
      await revalidateOverHttp(tenantId);
    }
    return true;
  } catch (error) {
    logger().warn(
      { tenantId, error: error instanceof Error ? error.message : String(error) },
      'storefront revalidation failed — the storefront stays stale until its TTL expires',
    );
    return false;
  }
}

/**
 * The marker a queue processor returns to ask for a revalidation AFTER its transaction commits.
 *
 * A processor cannot do this itself: `createWorker` wraps it in `withTenantTxn`, so anything it
 * calls runs pre-commit — and a tag dropped pre-commit races a concurrent read that repopulates
 * the cache from the old snapshot, which is the one outcome the drop exists to prevent.
 */
export interface RevalidatesStorefront {
  revalidateStorefront?: boolean;
}

export function wantsStorefrontRevalidation(result: unknown): boolean {
  return (
    typeof result === 'object' &&
    result !== null &&
    (result as RevalidatesStorefront).revalidateStorefront === true
  );
}
