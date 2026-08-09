import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { readRequestTenant } from '@/server/tenancy';
import type { RequestSurface } from './context';

/**
 * The storefront's entry guard.
 *
 * Everything comes from the context proxy.ts resolved and stamped onto the request — never from
 * a path segment, a query parameter or anything else a visitor controls. proxy.ts strips every
 * incoming `x-souq-*` header before setting its own, which is what makes reading them here safe
 * (docs/DECISIONS.md → the proxy does not believe the client).
 *
 * A request that reaches this subtree without a resolved tenant is a routing bug, and the
 * correct answer to it is 404 — never a fallback tenant, never the first row in the table.
 */
export interface StorefrontSurface extends RequestSurface {
  isSuspended: boolean;
}

export async function requireStorefront(): Promise<StorefrontSurface> {
  const tenant = readRequestTenant(await headers());

  if (tenant.surface !== 'storefront' || !tenant.tenantId) {
    notFound();
  }

  return {
    tenantId: tenant.tenantId,
    slug: tenant.slug ?? '',
    hostname: tenant.hostname,
    isDemo: tenant.isDemo,
    /**
     * A suspended storefront closes IMMEDIATELY — there is no grace period (Q2). The polite
     * Arabic pause page is rendered by the surface layout so every route in this subtree is
     * covered by construction; pages read this flag only to skip the database work they are
     * about to have thrown away.
     */
    isSuspended: tenant.isSuspended,
  };
}
