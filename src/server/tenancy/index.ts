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

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);

/**
 * Is this `Host` the server talking to itself?
 *
 * Next issues an INTERNAL request to its own listener when it follows a server action's
 * `redirect()`, and that request carries `Host: localhost:{port}` — the real hostname survives
 * only in `x-forwarded-host`. Nothing else about it looks unusual, which is what made the
 * resulting bug so odd: the browser sat on the right URL while the response was the 404 for an
 * unregistered hostname, and reloading the very same URL rendered the page correctly.
 *
 * `::1` is handled explicitly because `normaliseHostname` splits on `:` and would reduce it to
 * an empty string.
 */
export function isLoopbackHost(host: string | null | undefined): boolean {
  if (!host) return false;
  const value = host.trim().toLowerCase();
  if (LOOPBACK_HOSTS.has(value)) return true;

  const bare = value.startsWith('[')
    ? value.slice(0, value.indexOf(']') + 1)
    : normaliseHostname(value);

  return LOOPBACK_HOSTS.has(bare);
}

/**
 * The hostname the request is really FOR, which is not always the one it arrived on.
 *
 * `x-forwarded-host` is trusted in exactly one case: the request arrived on a loopback Host. A
 * public request never does — Caddy passes the real Host through, and the app listener is not
 * published outside the compose network — so the only thing that reaches us claiming to be
 * `localhost` is our own process. Trusting the header unconditionally would be a surface-choosing
 * vulnerability: a visitor could send `x-forwarded-host: admin.{DOMAIN}` and be routed into the
 * platform owner's tree. (The session guard on every admin page is what would still refuse them —
 * but routing must not depend on that being the last line.)
 */
export function effectiveHostHeader(headers: {
  get(name: string): string | null;
}): string | null {
  const host = headers.get('host');
  if (!isLoopbackHost(host)) return host;

  // A chain of proxies appends; the first entry is the original client-facing host.
  const forwarded = headers.get('x-forwarded-host');
  const first = forwarded?.split(',')[0]?.trim();
  return first ? first : host;
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
  /**
   * Phase 11 (Track 11.D): '1' exactly when the request is the live-preview segment — the same
   * predicate that relaxed `frame-ancestors` (Q37). The dashboard layout reads it to render the
   * preview WITHOUT the rail and chrome. Being in this map is what gets it stripped from every
   * incoming request; a client who forged it could only hide their own dashboard's chrome, but a
   * spoofable context header is a habit, not a judgement call.
   */
  preview: 'x-souq-preview',
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

// -----------------------------------------------------------------------------
// Surface roots — how three route trees share one Next app
// -----------------------------------------------------------------------------

/**
 * The three private surfaces are told apart by HOSTNAME, but the App Router routes by PATH.
 * Left alone, `admin.{DOMAIN}/`, `app.{DOMAIN}/` and `{slug}.{DOMAIN}/` are all the pathname
 * `/`, and three tracks each shipping a `page.tsx` for it is not a merge conflict — it is a
 * build error ("two parallel pages resolve to the same path"). `/products` would collide the
 * same way between the storefront and the dashboard.
 *
 * So proxy.ts rewrites every request into the surface's own subtree. The prefix is INTERNAL:
 * the visitor's URL bar never shows it, and every `href` in every track is written as the
 * public path (`/accounts`, not `/admin/accounts`) — the rewrite runs on client navigations
 * too, because RSC requests pass through the proxy exactly as document requests do.
 *
 * Folder ownership from docs/PHASES.md maps onto these one-to-one:
 *   (admin)      -> src/app/admin       (A1; B1 adds lifecycle/, B3 adds demos/)
 *   (dashboard)  -> src/app/dashboard   (B2)
 *   (storefront) -> src/app/site        (A2)
 *   (public)     -> unprefixed paths on app.* (B3's /demo-request)
 *
 * A parenthesised route group could not do this job: groups are erased from the URL, which is
 * precisely why all three would still land on `/`.
 */
export const SURFACE_ROOT = {
  admin: '/admin',
  app: '/dashboard',
  storefront: '/site',
} as const;

export type PrefixedSurface = keyof typeof SURFACE_ROOT;

/**
 * Paths that keep their public pathname on every surface.
 *
 * These are either hostname-agnostic infrastructure, or routes whose URL is a promise made to
 * someone outside the platform: `/export/{token}` is in a WhatsApp message a suspended merchant
 * may open weeks later (Q18), and `/demo-request` is on a business card. Rewriting either into
 * a surface subtree would break a link we already handed out.
 */
const UNPREFIXED_PATHS = [
  '/api/',
  '/internal/',
  '/export/',
  '/demo-request',
  // Phase 6's data-subject request box. A visitor, a push subscriber and a demo prospect have
  // no account, and the generated privacy policy prints this absolute URL — so it must resolve
  // on app.{DOMAIN} rather than be rewritten into a surface subtree.
  '/privacy-request',
  '/dev-media/',
  // proxy.ts's own rewrite targets. NextResponse.rewrite does not re-enter the proxy, so these
  // are belt and braces rather than load-bearing.
  '/demo-gate',
  '/unknown-host',
] as const;

export function isUnprefixedPath(pathname: string): boolean {
  return UNPREFIXED_PATHS.some(
    (prefix) => pathname === prefix.replace(/\/$/, '') || pathname.startsWith(prefix),
  );
}

/** `/accounts` on the admin surface -> `/admin/accounts`. `/` -> `/admin`. */
export function surfacePath(surface: PrefixedSurface, pathname: string): string {
  if (isUnprefixedPath(pathname)) return pathname;
  return pathname === '/' ? SURFACE_ROOT[surface] : `${SURFACE_ROOT[surface]}${pathname}`;
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
