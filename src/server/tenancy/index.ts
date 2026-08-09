import { publicDb } from '@/server/db';
import { CACHE_KEYS, CACHE_TTL, cacheDel, cacheGet, cacheSet } from '@/server/redis';
import { getEnv } from '@/env';

/**
 * Hostname -> tenant.
 *
 * Four surfaces live under one codebase and are told apart by hostname alone:
 *   admin.{DOMAIN}   the platform owner, and nobody else
 *   app.{DOMAIN}     merchant dashboards
 *   {slug}.{DOMAIN}  storefronts on the platform subdomain
 *   anything else    a merchant's custom domain, resolved through the Domain table
 *
 * The domain itself is always read from env — never hardcoded (CLAUDE.md).
 */

export type Surface = 'admin' | 'app' | 'storefront' | 'unknown';

export interface HostnameParse {
  hostname: string;
  surface: Surface;
  /** Present for a platform storefront subdomain; absent for a custom domain. */
  slug?: string;
  /** True when the hostname is not under the platform domain at all. */
  isCustomDomain: boolean;
}

/** Strips the port and lowercases. A Host header carries `:3000` in development. */
export function normaliseHostname(host: string | null | undefined): string {
  if (!host) return '';
  return host.split(':')[0]!.trim().toLowerCase();
}

const RESERVED_SUBDOMAINS = new Set([
  'www',
  'mail',
  'smtp',
  'imap',
  'ftp',
  'ns1',
  'ns2',
  'n8n',
  'umami',
  'status',
  'uptime',
  'api',
  'cdn',
  'static',
  'assets',
  'demo',
  'staging',
  'test',
]);

export function isReservedSlug(slug: string): boolean {
  const env = getEnv();
  return (
    RESERVED_SUBDOMAINS.has(slug) ||
    slug === env.ADMIN_HOST_PREFIX ||
    slug === env.APP_HOST_PREFIX
  );
}

export function parseHostname(rawHost: string | null | undefined): HostnameParse {
  const env = getEnv();
  const hostname = normaliseHostname(rawHost);
  const domain = env.DOMAIN.toLowerCase();

  if (!hostname) {
    return { hostname: '', surface: 'unknown', isCustomDomain: false };
  }

  if (hostname === `${env.ADMIN_HOST_PREFIX}.${domain}`) {
    return { hostname, surface: 'admin', isCustomDomain: false };
  }

  if (hostname === `${env.APP_HOST_PREFIX}.${domain}`) {
    return { hostname, surface: 'app', isCustomDomain: false };
  }

  if (hostname.endsWith(`.${domain}`)) {
    const slug = hostname.slice(0, -(domain.length + 1));
    // Only a single label is a storefront: `a.b.{DOMAIN}` is not a slug, it is a mistake.
    if (slug && !slug.includes('.') && !isReservedSlug(slug)) {
      return { hostname, surface: 'storefront', slug, isCustomDomain: false };
    }
    return { hostname, surface: 'unknown', isCustomDomain: false };
  }

  // Everything else is a candidate custom domain — the Domain table decides.
  return { hostname, surface: 'storefront', isCustomDomain: true };
}

export interface TenantContext {
  tenantId: string;
  slug: string;
  name: string;
  /** THE canonical demo predicate. A2 renders the watermark, noindex and gate from this. */
  isDemo: boolean;
  /** A suspended storefront serves the polite Arabic pause page instead of the site. */
  isSuspended: boolean;
  /** A purging tenant must not be served at all. */
  isPurging: boolean;
}

/**
 * Resolve a hostname to its tenant, Redis-cached.
 *
 * Runs with NO tenant context — that is the point, and it is why migration 0001 opens a narrow
 * SELECT on `domains` that closes again the moment a tenant context exists.
 *
 * A null result is a 404. Never a fallback tenant, never the first tenant in the table.
 */
export async function resolveTenantByHostname(hostname: string): Promise<TenantContext | null> {
  const host = normaliseHostname(hostname);
  if (!host) return null;

  const cacheKey = CACHE_KEYS.tenantByHost(host);
  const cached = await cacheGet<TenantContext | { missing: true }>(cacheKey);
  if (cached) {
    return 'missing' in cached ? null : cached;
  }

  const parsed = parseHostname(host);
  const db = publicDb();

  /**
   * Only the tenant row is read here, never the subscription.
   *
   * A pre-context SELECT policy on `subscriptions` would expose `exportDownloadToken` — a
   * bearer credential to a merchant's entire catalogue — to any unauthenticated request.
   * `Tenant.state` is the serving read model that exists so this lookup never has to.
   */
  const tenantSelect = {
    id: true,
    slug: true,
    name: true,
    isDemo: true,
    state: true,
  } as const;

  let tenant: {
    id: string;
    slug: string;
    name: string;
    isDemo: boolean;
    state: string;
  } | null = null;

  if (parsed.surface === 'storefront' && parsed.slug) {
    tenant = await db.tenant.findUnique({ where: { slug: parsed.slug }, select: tenantSelect });
  } else if (parsed.isCustomDomain) {
    const domain = await db.domain.findUnique({
      where: { hostname: host },
      select: { status: true, tenantId: true },
    });

    // A verified-but-not-active domain is not yet a live site; Phase 4 flips it.
    if (domain && (domain.status === 'active' || domain.status === 'verified')) {
      tenant = await db.tenant.findUnique({ where: { id: domain.tenantId }, select: tenantSelect });
    }
  }

  if (!tenant) {
    // Cache the miss too: an unknown hostname is exactly what a scanner hammers, and each
    // miss would otherwise be a database round trip.
    await cacheSet(cacheKey, { missing: true }, 60);
    return null;
  }

  const context: TenantContext = {
    tenantId: tenant.id,
    slug: tenant.slug,
    name: tenant.name,
    isDemo: tenant.isDemo,
    isSuspended: tenant.state === 'suspended',
    isPurging: tenant.state === 'purging',
  };

  await cacheSet(cacheKey, context, CACHE_TTL.host);
  return context;
}

/**
 * Invalidated on every Domain change (Phase 4) and on every lifecycle transition, so a
 * suspended site closes immediately rather than at the end of a TTL.
 */
export async function invalidateHostname(hostname: string): Promise<void> {
  await cacheDel(CACHE_KEYS.tenantByHost(normaliseHostname(hostname)));
}

export async function invalidateTenantHostnames(tenantId: string): Promise<void> {
  const env = getEnv();
  const db = publicDb();

  const tenant = await db.tenant.findUnique({ where: { id: tenantId }, select: { slug: true } });
  const domains = await db.domain.findMany({ where: { tenantId }, select: { hostname: true } });

  const keys = [
    ...(tenant ? [`${tenant.slug}.${env.DOMAIN}`] : []),
    ...domains.map((d) => d.hostname),
  ].map((host) => CACHE_KEYS.tenantByHost(normaliseHostname(host)));

  await cacheDel(...keys);
}

// -----------------------------------------------------------------------------
// Demo access (Q8)
// -----------------------------------------------------------------------------

export const DEMO_TOKEN_QUERY_PARAM = 'token';
export const DEMO_TOKEN_COOKIE = 'souq_demo_token';

/**
 * Magic-link only. A demo hostname without a valid token gets the Arabic rejection page —
 * noindex stays as a second layer, never as the mechanism.
 */
export async function isDemoTokenValid(tenantId: string, token: string | undefined): Promise<boolean> {
  if (!token) return false;

  const link = await publicDb().demoLink.findFirst({
    where: { token },
    select: { tenantId: true, revokedAt: true, expiresAt: true },
  });

  if (!link || link.tenantId !== tenantId) return false;
  if (link.revokedAt) return false;
  if (link.expiresAt && link.expiresAt.getTime() < Date.now()) return false;

  return true;
}

// -----------------------------------------------------------------------------
// Request-context headers
// -----------------------------------------------------------------------------

/**
 * The proxy passes its findings downstream as headers. These names are stripped from every
 * INCOMING request before being set — otherwise a visitor could send
 * `x-souq-tenant-id: <someone else>` and be believed.
 */
export const TENANT_HEADERS = {
  tenantId: 'x-souq-tenant-id',
  slug: 'x-souq-tenant-slug',
  surface: 'x-souq-surface',
  isDemo: 'x-souq-is-demo',
  isSuspended: 'x-souq-is-suspended',
  hostname: 'x-souq-hostname',
} as const;

export const TENANT_HEADER_NAMES = Object.values(TENANT_HEADERS);

export interface RequestTenant {
  tenantId: string | null;
  slug: string | null;
  surface: Surface;
  isDemo: boolean;
  isSuspended: boolean;
  hostname: string;
}

/** Read the context the proxy resolved. Server components and route handlers use this. */
export function readRequestTenant(headers: { get(name: string): string | null }): RequestTenant {
  const surface = (headers.get(TENANT_HEADERS.surface) ?? 'unknown') as Surface;
  return {
    tenantId: headers.get(TENANT_HEADERS.tenantId),
    slug: headers.get(TENANT_HEADERS.slug),
    surface,
    isDemo: headers.get(TENANT_HEADERS.isDemo) === '1',
    isSuspended: headers.get(TENANT_HEADERS.isSuspended) === '1',
    hostname: headers.get(TENANT_HEADERS.hostname) ?? '',
  };
}
