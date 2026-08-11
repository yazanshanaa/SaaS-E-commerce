import { z } from 'zod';
import { getEnv } from '@/env';
import { randomToken } from '@/server/crypto';
import {
  VERIFICATION_TXT_LABEL,
  checkDomainOwnership,
  cnameTarget,
  customHostnameSchema,
  resolveDomainCap,
  verificationTxtValue,
  type DomainCap,
  type VerificationFailure,
  type VerificationMethod,
} from '@/server/domains';
import { logger } from '@/server/logger';
import { consumeSlot } from '@/server/rate-limit';
import { invalidateHostname } from '@/server/tenancy';
import type { MerchantContext } from './context';
import { audit } from './audit';
import { failure, invalid, type ActionState } from './validation';

/**
 * The merchant's custom-domain flow — CNAME only in V1 (Q7).
 *
 * Three things live here rather than in `src/server/domains`, and all three need a
 * `MerchantContext`: the audit row, the cap enforced against THIS tenant, and the Arabic message
 * keys. The primitives underneath — hostname rules, the DNS probe, the ownership proof, the cap
 * arithmetic — are testable without a session and stay where they are.
 *
 * The screen this feeds is deliberately instructional rather than magical. A merchant is about to
 * edit DNS at a registrar this platform has never heard of, and the single most common way that
 * goes wrong is not a typo: it is Cloudflare's orange cloud. A proxied record is flattened, so the
 * CNAME becomes invisible to every resolver AND the ACME challenge never arrives — which looks,
 * from the merchant's side, exactly like "your platform is broken". The warning is therefore part
 * of the instructions, not a troubleshooting page nobody reaches.
 */

export type DomainStatus = 'pending' | 'verified' | 'active' | 'failed';

export interface DomainRow {
  id: string;
  hostname: string;
  status: DomainStatus;
  isPrimary: boolean;
  verifiedAt: Date | null;
  activatedAt: Date | null;
  lastCheckedAt: Date | null;
  /** The last DNS failure, as a message key — never a raw resolver error. */
  failureKey: string | null;
}

export interface DomainInstructions {
  /** What the merchant's CNAME must point at: their own platform subdomain. */
  cnameTarget: string;
  /** The fallback proof: a TXT record with this value, on the host or on `_souq-verify.{host}`. */
  txtLabel: string;
  /**
   * NULL until a Domain row exists, and the screen renders no TXT block at all until then.
   *
   * The token is minted per domain when the row is created, so before that there is nothing
   * honest to show. Showing a freshly generated one would be worse than showing nothing: it is
   * regenerated on every render and never stored, so a merchant who followed the instructions —
   * which tell them in as many words to publish these values and come back — would publish a
   * value that can never match, and «تحقّق» would refuse a record they can see in their own DNS
   * with no way to work out why.
   */
  txtValue: string | null;
}

export interface DomainsView {
  cap: DomainCap;
  domains: DomainRow[];
  instructions: DomainInstructions;
  platformHostname: string;
}

const FAILURE_KEYS: Record<VerificationFailure, string> = {
  cnameMismatch: 'dashboard:domain.errors.cnameMismatch',
  proxied: 'dashboard:domain.errors.proxied',
  missing: 'dashboard:domain.errors.missing',
};

/**
 * The verification token is per DOMAIN and is generated when the row is created.
 *
 * It is not a secret in the sense of a credential — it ends up published in the merchant's own
 * public DNS — but it must be unguessable, because guessing it is how somebody else proves
 * control of a name they do not own. 16 bytes of base64url; guessing one is arithmetic, not a
 * threat model.
 */
function newVerificationToken(): string {
  return randomToken(16);
}

export async function loadDomains(ctx: MerchantContext): Promise<DomainsView | null> {
  const tenant = await ctx.db.tenant.findUnique({
    where: { id: ctx.tenantId },
    select: { slug: true },
  });
  if (!tenant) return null;

  const rows = await ctx.db.domain.findMany({
    where: { tenantId: ctx.tenantId, kind: 'custom' },
    orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
    select: {
      id: true,
      hostname: true,
      status: true,
      isPrimary: true,
      verifiedAt: true,
      activatedAt: true,
      lastCheckedAt: true,
      failureReason: true,
      verificationToken: true,
    },
  });

  const cap = await resolveDomainCap(ctx.tenantId, rows.length);

  /**
   * The token that drives the TXT instructions is the pending row's OWN, or nothing.
   *
   * `domains_limit` is 1 on every plan that has the feature, so "the pending row" is unambiguous
   * in practice. There is deliberately no fallback: an earlier version generated a fresh token
   * when no row existed, so the whole procedure could be read before committing — but that token
   * was regenerated on every render and stored nowhere, while the copy beside it told the merchant
   * to publish these values and come back. Anyone who took the TXT path first published a value
   * that could never match, and «تحقّق» would then refuse a record sitting in their own DNS.
   *
   * The CNAME half is complete without a row (its target is the tenant's platform subdomain, which
   * always exists), and it is the path the instructions lead with — so a merchant deciding whether
   * their registrar can do this still has everything they need before adding anything.
   */
  const pending = rows.find((row) => row.status !== 'active') ?? rows[0];

  return {
    cap,
    domains: rows.map((row) => ({
      id: row.id,
      hostname: row.hostname,
      status: row.status as DomainStatus,
      isPrimary: row.isPrimary,
      verifiedAt: row.verifiedAt,
      activatedAt: row.activatedAt,
      lastCheckedAt: row.lastCheckedAt,
      failureKey: row.failureReason,
    })),
    instructions: {
      cnameTarget: cnameTarget(tenant.slug),
      txtLabel: VERIFICATION_TXT_LABEL,
      txtValue: pending?.verificationToken
        ? verificationTxtValue(pending.verificationToken)
        : null,
    },
    platformHostname: `${tenant.slug}.${getEnv().DOMAIN}`,
  };
}

// -----------------------------------------------------------------------------
// Add
// -----------------------------------------------------------------------------

export const addDomainSchema = z.object({ hostname: customHostnameSchema });

/**
 * Add a hostname in `pending`.
 *
 * The cap is enforced HERE and not in the form (invariant 2: never let a route trust the client).
 * It is also not a cosmetic limit: every hostname is a certificate this platform will ask
 * Let's Encrypt for against per-account rate limits SHARED with every other merchant on the box.
 *
 * A hostname already claimed by ANOTHER tenant surfaces as a unique-constraint violation, because
 * RLS hides that tenant's row from this query — there is no read that could have checked first.
 * It is answered with the same Arabic sentence as "you already added this", which is not an
 * information leak worth agonising over (DNS is public, and the name either resolves here or it
 * does not) but is worth not confirming precisely.
 */
export async function addDomain(
  ctx: MerchantContext,
  raw: unknown,
): Promise<ActionState | null> {
  const parsed = addDomainSchema.safeParse(raw);
  if (!parsed.success) return invalid(parsed.error);

  const used = await ctx.db.domain.count({ where: { tenantId: ctx.tenantId, kind: 'custom' } });
  const cap = await resolveDomainCap(ctx.tenantId, used);

  if (!cap.allowed) return failure('dashboard:errors.forbidden');
  if (cap.remaining <= 0) return failure('dashboard:domain.errors.capReached');

  const hostname = parsed.data.hostname;

  try {
    const created = await ctx.db.domain.create({
      data: {
        tenantId: ctx.tenantId,
        hostname,
        kind: 'custom',
        status: 'pending',
        // The first custom domain a tenant adds is its primary by default. With the cap at 1 on
        // every plan that has the feature there is never a second one to choose between, and a
        // picker for a list that cannot exceed one entry is a control with nothing to control.
        isPrimary: used === 0,
        verificationToken: newVerificationToken(),
      },
      select: { id: true },
    });

    await audit(ctx, {
      action: 'domain.added',
      entityType: 'domain',
      entityId: created.id,
      after: { hostname, status: 'pending' },
    });
  } catch (error) {
    if (isUniqueViolation(error)) return failure('dashboard:domain.errors.taken');
    throw error;
  }

  return null;
}

// -----------------------------------------------------------------------------
// Verify
// -----------------------------------------------------------------------------

export const domainIdSchema = z.object({ domainId: z.string().min(1, 'dashboard:errors.required') });

export interface VerifyOutcome {
  state: ActionState | null;
  method?: VerificationMethod;
}

/**
 * Ask public DNS whether the merchant has done their half.
 *
 * Rate-limited per tenant because each attempt is up to four live queries against 1.1.1.1 and
 * 8.8.8.8 — and because the button is exactly the thing an impatient merchant clicks twenty times
 * while waiting for propagation.
 *
 * A success moves `pending -> verified`, which is as far as this platform can honestly go: it
 * proves the record exists, not that the domain is serving. `active` is stamped by the on-demand
 * TLS ask, which is the only party that ever learns a certificate was issued.
 */
export async function verifyDomain(
  ctx: MerchantContext,
  raw: unknown,
): Promise<ActionState | null> {
  if ((await resolveDomainCap(ctx.tenantId, 0)).allowed !== true) {
    return failure('dashboard:errors.forbidden');
  }

  const parsed = domainIdSchema.safeParse(raw);
  if (!parsed.success) return invalid(parsed.error);

  const slot = await consumeSlot({
    key: `domain:verify:${ctx.tenantId}`,
    limit: getEnv().RATE_LIMIT_DOMAIN_VERIFY_PER_HOUR,
    windowSeconds: 3_600,
  });
  if (!slot.allowed) return failure('dashboard:domain.errors.tooManyChecks');

  const domain = await ctx.db.domain.findFirst({
    where: { id: parsed.data.domainId, tenantId: ctx.tenantId, kind: 'custom' },
    select: { id: true, hostname: true, status: true, verificationToken: true },
  });
  if (!domain) return failure('dashboard:errors.notFound');

  const tenant = await ctx.db.tenant.findUnique({
    where: { id: ctx.tenantId },
    select: { slug: true },
  });
  if (!tenant) return failure('dashboard:errors.notFound');

  const result = await checkDomainOwnership({
    hostname: domain.hostname,
    cnameTarget: cnameTarget(tenant.slug),
    token: domain.verificationToken ?? '',
  });

  const now = new Date();

  if (!result.verified) {
    const failureKey = FAILURE_KEYS[result.failure ?? 'missing'];

    await ctx.db.domain.update({
      where: { id: domain.id },
      data: {
        // A domain that was already `verified` or `active` is NOT demoted by one failed check.
        // DNS is not always reachable, and taking a working site's certificate away because a
        // resolver timed out is a self-inflicted outage. Only a pending domain records `failed`.
        status: domain.status === 'pending' ? 'failed' : (domain.status as 'verified' | 'active'),
        failureReason: failureKey,
        lastCheckedAt: now,
      },
    });

    logger().info(
      { tenantId: ctx.tenantId, hostname: domain.hostname, failure: result.failure },
      'domain verification failed',
    );

    return failure(failureKey);
  }

  await ctx.db.domain.update({
    where: { id: domain.id },
    data: {
      // Never demote an already-active domain back to `verified`: it is serving, and the ask
      // endpoint has no reason to run again until the certificate renews.
      status: domain.status === 'active' ? 'active' : 'verified',
      verifiedAt: now,
      lastCheckedAt: now,
      failureReason: null,
    },
  });

  await audit(ctx, {
    action: 'domain.verified',
    entityType: 'domain',
    entityId: domain.id,
    after: { hostname: domain.hostname, method: result.method },
  });

  // The hostname now resolves to this tenant — `resolveTenantByHostname` accepts `verified` and
  // `active` — and proxy.ts may already have cached the miss it answered a minute ago.
  await invalidateHostname(domain.hostname);

  return null;
}

// -----------------------------------------------------------------------------
// Remove
// -----------------------------------------------------------------------------

/**
 * Remove a domain, and drop the hostname cache with it.
 *
 * Without the invalidation the storefront would go on answering on a hostname the merchant just
 * released, for up to the cache TTL — and once they point that name somewhere else, at whoever
 * buys it next, that is this platform serving someone else's traffic.
 */
export async function removeDomain(
  ctx: MerchantContext,
  raw: unknown,
): Promise<ActionState | null> {
  const parsed = domainIdSchema.safeParse(raw);
  if (!parsed.success) return invalid(parsed.error);

  const domain = await ctx.db.domain.findFirst({
    where: { id: parsed.data.domainId, tenantId: ctx.tenantId, kind: 'custom' },
    select: { id: true, hostname: true, status: true },
  });
  if (!domain) return failure('dashboard:errors.notFound');

  await ctx.db.domain.delete({ where: { id: domain.id } });

  await audit(ctx, {
    action: 'domain.removed',
    entityType: 'domain',
    entityId: domain.id,
    before: { hostname: domain.hostname, status: domain.status },
  });

  await invalidateHostname(domain.hostname);

  return null;
}

// -----------------------------------------------------------------------------

/** Prisma's unique-constraint code, without importing the client outside `src/server/db`. */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'P2002'
  );
}
