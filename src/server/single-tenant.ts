import { readFileSync } from 'node:fs';
import { getEnv } from '@/env';
import type { FeatureKey, FeatureValue } from '@/shared/features';

/**
 * SINGLE-TENANT MODE (Q25) — the whole seam, in one file.
 *
 * A standalone bundle is this same codebase serving ONE shop on its own server with no platform
 * around it. Rather than fork the application — which would rot the moment the platform moved on —
 * the bundle sets `SINGLE_TENANT_MODE=1` and a small number of named branches change behaviour.
 *
 * ONE FILE, NOT SCATTERED `process.env` READS. Every branch in the application asks a function
 * here. That is what makes the mode auditable: this file is the complete list of ways the two
 * deployments differ, and the last block of `tests/unit/phase10-tenant-backup.test.ts` asserts the
 * mode is INERT when off — which is the property that matters most, because the platform runs with
 * it off and a bug in this file would be a bug in production for a feature production never uses.
 *
 * WHAT THE MODE CHANGES, and nothing else:
 *   1. HOSTNAMES. The root host serves the storefront; `/dashboard` serves the merchant dashboard;
 *      the admin surface and every demo route answer 404.
 *   2. ENTITLEMENTS. `can()` reads a frozen snapshot shipped in the bundle instead of resolving
 *      plans that do not exist there.
 *   3. LIFECYCLE. The subscription sweeps, reminders and the purge do nothing: there is no billing
 *      relationship on a server the merchant owns.
 *   4. CHANGE REQUESTS. Nothing is `editable_by: admin`, because there is no admin to ask.
 *
 * WHAT IT DOES NOT CHANGE IN CODE: the scoped client and `withTenantTxn` run exactly as they do on
 * the platform. Every query still carries `app.tenant_id`, still goes through the same guards, and
 * a bug that tried to reach another tenant would still be reaching for a row that does not exist.
 *
 * WHAT IT DOES CHANGE IN DEPLOYMENT, stated plainly because a comfortable half-truth here would be
 * worse than nothing: the bundle's compose provisions ONE Postgres role and the app connects as the
 * database owner, so ROW-LEVEL SECURITY IS INERT THERE. Postgres does not enforce policies against
 * a table's owner unless `FORCE ROW LEVEL SECURITY` is paired with a non-owner connection, and the
 * platform's `app_web` / `app_system` roles are `NOLOGIN` — they exist to be assumed by a
 * connection string this deployment does not have.
 *
 * That is defensible for exactly one reason: there is one tenant, so there is no second tenant's
 * data for a policy to protect. It stops being defensible the moment a bundle serves two shops, and
 * whoever tries that must provision the roles first (`prisma/migrations/20260809000100_…`) and point
 * `DATABASE_URL` at `app_web`, leaving `DATABASE_URL_MIGRATE` on the owner. `docs/PHASE-10.md`
 * carries this as a named limitation rather than a footnote.
 */

export interface StandaloneEntitlements {
  tenantId: string;
  takenAt: string;
  features: Partial<Record<FeatureKey, FeatureValue>>;
}

export function isSingleTenant(): boolean {
  return getEnv().SINGLE_TENANT_MODE === true;
}

/**
 * The one tenant, or null.
 *
 * Returns null rather than throwing when the mode is off, so a caller can write
 * `singleTenantId() ?? (await resolve())` — the shape every seam below uses.
 */
export function singleTenantId(): string | null {
  const env = getEnv();
  return env.SINGLE_TENANT_MODE ? (env.SINGLE_TENANT_ID ?? null) : null;
}

/**
 * The path prefix the merchant dashboard answers on in standalone mode.
 *
 * A PATH rather than a subdomain, deliberately: a standalone owner has one certificate for one
 * name, and asking them to add `app.` — a second DNS record, a second certificate, and a wildcard
 * they may not be able to issue — would be the step that stops half of these deployments from ever
 * going live.
 */
export const STANDALONE_DASHBOARD_PREFIX = '/dashboard';

/**
 * Is this request for the dashboard rather than the storefront?
 *
 * `/dashboard` and everything under it, plus the auth routes the dashboard needs — `/api/auth` is
 * better-auth's own mount point and is not under the prefix.
 */
export function isStandaloneDashboardPath(pathname: string): boolean {
  return (
    pathname === STANDALONE_DASHBOARD_PREFIX ||
    pathname.startsWith(`${STANDALONE_DASHBOARD_PREFIX}/`) ||
    pathname.startsWith('/api/auth')
  );
}

/**
 * Strip the prefix, because the dashboard's own routes live at `/products`, `/orders` and so on —
 * the same paths they occupy on `app.{DOMAIN}`.
 *
 * Not stripping it would mean either a parallel route tree or every `href` in the dashboard
 * knowing which deployment it is on. Both are worse: the first duplicates B2's whole surface, and
 * the second puts a mode check in three hundred components.
 */
export function stripDashboardPrefix(pathname: string): string {
  if (pathname === STANDALONE_DASHBOARD_PREFIX) return '/';
  if (pathname.startsWith(`${STANDALONE_DASHBOARD_PREFIX}/`)) {
    return pathname.slice(STANDALONE_DASHBOARD_PREFIX.length) || '/';
  }
  return pathname;
}

// -----------------------------------------------------------------------------
// The frozen entitlement snapshot
// -----------------------------------------------------------------------------

let snapshot: StandaloneEntitlements | null | undefined;

/**
 * Read `standalone/entitlements.json`, once.
 *
 * MISSING IS NOT "EVERYTHING ON". A bundle whose snapshot failed to ship is a broken bundle, and
 * resolving it to full access would silently hand out every paid feature — including the ones that
 * collect customer data (`cart`, `payment_gateway`), which is the last thing to enable by accident.
 * The loader returns null and `can()` falls back to its plan lookup, which on a standalone
 * deployment finds no plan and therefore answers false. Fail closed, loudly, in the logs.
 */
export function loadStandaloneEntitlements(): StandaloneEntitlements | null {
  if (snapshot !== undefined) return snapshot;

  if (!isSingleTenant()) {
    snapshot = null;
    return snapshot;
  }

  try {
    // The PATH is computed, not the import — a static `node:fs` import is what the rest of the
    // codebase does and what `@typescript-eslint/no-require-imports` requires. The guard above
    // means this never runs on the platform, so the file's absence there costs nothing.
    const path = process.env.STANDALONE_ENTITLEMENTS_PATH ?? './standalone/entitlements.json';
    snapshot = JSON.parse(readFileSync(path, 'utf8')) as StandaloneEntitlements;
  } catch {
    snapshot = null;
  }

  return snapshot;
}

/** Test-only, and the reason `snapshot` is not a `const`. */
export function resetStandaloneEntitlements(): void {
  snapshot = undefined;
}
