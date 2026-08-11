import { headers } from 'next/headers';
import { readRequestTenant } from '@/server/tenancy';
import { loadStorefrontContext } from './context';
import type { StorefrontContext } from '@/templates';

/**
 * The entry every PWA route shares.
 *
 * It is separate from `requireStorefront()` because these three routes answer for a MACHINE — a
 * browser's install logic, a service-worker registration, a launcher fetching an icon — and the
 * right refusal for a machine is a status code, not a rendered 404 page. `notFound()` inside a
 * route handler would send an HTML document with a `text/html` content type to something that
 * asked for `application/manifest+json`.
 *
 * Suspended is a refusal here, and deliberately so: the storefront is closed, and a shop that
 * still advertises an installable app — or worse, one already on a customer's home screen that
 * opens the pause page — is a promise the account is not currently keeping. The ask endpoint
 * still issues the certificate so the pause page arrives over HTTPS; that is a different question.
 */

export interface PwaSurface {
  tenantId: string;
  context: StorefrontContext;
}

export type PwaGate = 'pwa' | 'worker';

/**
 * @param gate `pwa` requires the feature AND the merchant's switch. `worker` also accepts a
 * tenant that only has `push_notifications`: a push cannot be received without a service worker
 * in any browser, so a احترافي merchant who never turned on the PWA still needs one registered.
 */
export async function resolvePwaSurface(gate: PwaGate): Promise<PwaSurface | null> {
  const tenant = readRequestTenant(await headers());

  if (tenant.surface !== 'storefront' || !tenant.tenantId || tenant.isSuspended) return null;

  const context = await loadStorefrontContext({
    tenantId: tenant.tenantId,
    slug: tenant.slug ?? '',
    hostname: tenant.hostname,
    isDemo: tenant.isDemo,
  });

  const allowed = gate === 'pwa' ? context.flags.pwa : context.flags.pwa || context.flags.push;
  if (!allowed) return null;

  return { tenantId: tenant.tenantId, context };
}
