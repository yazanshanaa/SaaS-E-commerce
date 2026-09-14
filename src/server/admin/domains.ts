import { z } from 'zod';
import { getEnv, storefrontHost } from '@/env';
import { randomToken } from '@/server/crypto';
import {
  VERIFICATION_TXT_LABEL,
  checkDomainOwnership,
  cnameTarget,
  customHostnameSchema,
  verificationTxtValue,
  type VerificationFailure,
} from '@/server/domains';
import { logger } from '@/server/logger';
import { invalidateHostname, isReservedSlug } from '@/server/tenancy';
import { auditTenantAction } from './audit';
import type { AdminContext } from './context';
import { failure, invalid, slugField, type ActionState } from './validation';

/**
 * The platform owner's domain desk, per account (2026-09-13, owner-directed).
 *
 * Until now a shop's addresses were the MERCHANT's to manage from `app.{DOMAIN}/settings/domain`, and
 * the admin could only read them. The owner attaches and activates domains himself — over the
 * phone with the merchant, or before hand-over — so the whole flow lives here too, with two
 * differences from the merchant's copy in `src/app/dashboard/_lib/domains.ts`:
 *
 *   - NO PLAN CAP. The owner decides what an account gets; the `custom_domain` feature toggle on
 *     the permissions tab remains the switch that shows or hides the merchant's own screen.
 *   - THE SUBDOMAIN IS EDITABLE. `{slug}.{DOMAIN}` is the address every shop has from day one and
 *     the merchant cannot change it. The owner can — renaming a shop, fixing a typo at onboarding.
 *     The old hostname stops answering on the next request (cache invalidated), the new one starts.
 *
 * Every mutation is audited against the tenant. Status semantics are unchanged: `pending` →
 * `verified` (a DNS proof landed) → `active` (Caddy's ask endpoint saw a certificate issue).
 */

const FAILURE_KEYS: Record<VerificationFailure, string> = {
  cnameMismatch: 'admin:domains.errors.cnameMismatch',
  proxied: 'admin:domains.errors.proxied',
  missing: 'admin:domains.errors.missing',
};

export interface AdminDomainRow {
  id: string;
  hostname: string;
  status: 'pending' | 'verified' | 'active' | 'failed';
  isPrimary: boolean;
  verifiedAt: Date | null;
  activatedAt: Date | null;
  lastCheckedAt: Date | null;
  failureKey: string | null;
  txtValue: string | null;
}

export interface AdminDomainsView {
  slug: string;
  platformHostname: string;
  platformUrl: string;
  cnameTarget: string;
  txtLabel: string;
  domains: AdminDomainRow[];
}

export async function getAccountDomains(
  ctx: AdminContext,
  tenantId: string,
): Promise<AdminDomainsView | null> {
  const tenant = await ctx.db.tenant.findUnique({ where: { id: tenantId }, select: { slug: true } });
  if (!tenant) return null;

  const rows = await ctx.db.domain.findMany({
    where: { tenantId, kind: 'custom' },
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

  const host = storefrontHost(tenant.slug);
  return {
    slug: tenant.slug,
    platformHostname: host,
    platformUrl: `${getEnv().PUBLIC_SCHEME}://${host}`,
    cnameTarget: cnameTarget(tenant.slug),
    txtLabel: VERIFICATION_TXT_LABEL,
    domains: rows.map((row) => ({
      id: row.id,
      hostname: row.hostname,
      status: row.status as AdminDomainRow['status'],
      isPrimary: row.isPrimary,
      verifiedAt: row.verifiedAt,
      activatedAt: row.activatedAt,
      lastCheckedAt: row.lastCheckedAt,
      failureKey: row.failureReason,
      txtValue: row.verificationToken ? verificationTxtValue(row.verificationToken) : null,
    })),
  };
}

// -----------------------------------------------------------------------------
// The platform subdomain
// -----------------------------------------------------------------------------

const slugSchema = z.object({ slug: slugField });

export async function changeAccountSlug(
  ctx: AdminContext,
  tenantId: string,
  raw: unknown,
): Promise<ActionState | null> {
  const parsed = slugSchema.safeParse(raw);
  if (!parsed.success) return invalid(parsed.error);
  const next = parsed.data.slug;

  if (isReservedSlug(next)) {
    return failure('admin:errors.validation', [{ field: 'slug', messageKey: 'admin:errors.slugReserved' }]);
  }

  const tenant = await ctx.db.tenant.findUnique({ where: { id: tenantId }, select: { slug: true } });
  if (!tenant) return failure('admin:errors.notFound');
  if (tenant.slug === next) return null;

  const taken = await ctx.db.tenant.findUnique({ where: { slug: next }, select: { id: true } });
  if (taken) {
    return failure('admin:errors.validation', [{ field: 'slug', messageKey: 'admin:errors.slugTaken' }]);
  }

  await ctx.db.tenant.update({ where: { id: tenantId }, data: { slug: next } });

  await auditTenantAction(ctx, tenantId, {
    action: 'domain.slug_changed',
    entityType: 'tenant',
    entityId: tenantId,
    before: { slug: tenant.slug },
    after: { slug: next },
  });

  // The old address must stop answering and the new one must start on the next request.
  await Promise.all([
    invalidateHostname(storefrontHost(tenant.slug)),
    invalidateHostname(storefrontHost(next)),
  ]);

  return null;
}

// -----------------------------------------------------------------------------
// Custom domains
// -----------------------------------------------------------------------------

const hostnameSchema = z.object({ hostname: customHostnameSchema });
const domainIdSchema = z.object({ domainId: z.string().min(1, 'admin:errors.required') });

export async function adminAddDomain(
  ctx: AdminContext,
  tenantId: string,
  raw: unknown,
): Promise<ActionState | null> {
  const parsed = hostnameSchema.safeParse(raw);
  if (!parsed.success) return invalid(parsed.error);
  const hostname = parsed.data.hostname;

  const exists = await ctx.db.domain.findUnique({
    where: { hostname },
    select: { id: true, tenantId: true },
  });
  if (exists) return failure('admin:domains.errors.taken');

  const used = await ctx.db.domain.count({ where: { tenantId, kind: 'custom' } });

  const created = await ctx.db.domain.create({
    data: {
      tenantId,
      hostname,
      kind: 'custom',
      status: 'pending',
      isPrimary: used === 0,
      verificationToken: randomToken(16),
    },
    select: { id: true },
  });

  await auditTenantAction(ctx, tenantId, {
    action: 'domain.added',
    entityType: 'domain',
    entityId: created.id,
    after: { hostname, status: 'pending', by: 'admin' },
  });

  return null;
}

export async function adminVerifyDomain(
  ctx: AdminContext,
  tenantId: string,
  raw: unknown,
): Promise<ActionState | null> {
  const parsed = domainIdSchema.safeParse(raw);
  if (!parsed.success) return invalid(parsed.error);

  const [domain, tenant] = await Promise.all([
    ctx.db.domain.findFirst({
      where: { id: parsed.data.domainId, tenantId, kind: 'custom' },
      select: { id: true, hostname: true, status: true, verificationToken: true },
    }),
    ctx.db.tenant.findUnique({ where: { id: tenantId }, select: { slug: true } }),
  ]);
  if (!domain || !tenant) return failure('admin:errors.notFound');

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
        status: domain.status === 'pending' ? 'failed' : (domain.status as 'verified' | 'active'),
        failureReason: failureKey,
        lastCheckedAt: now,
      },
    });
    logger().info({ tenantId, hostname: domain.hostname, failure: result.failure }, 'admin domain check failed');
    return failure(failureKey);
  }

  await ctx.db.domain.update({
    where: { id: domain.id },
    data: {
      status: domain.status === 'active' ? 'active' : 'verified',
      verifiedAt: now,
      lastCheckedAt: now,
      failureReason: null,
    },
  });

  await auditTenantAction(ctx, tenantId, {
    action: 'domain.verified',
    entityType: 'domain',
    entityId: domain.id,
    after: { hostname: domain.hostname, method: result.method, by: 'admin' },
  });

  await invalidateHostname(domain.hostname);
  return null;
}

/**
 * The owner's override: mark a domain verified WITHOUT a DNS proof.
 *
 * For the case where the owner has seen the record himself (in the registrar's panel, on a call)
 * and the resolver this server asks has not caught up. It makes the hostname resolve to the
 * tenant immediately; the certificate still needs the CNAME to actually reach this server, so
 * the screen says so. Audited as a distinct action so it is always visible that no proof landed.
 */
export async function adminForceVerifyDomain(
  ctx: AdminContext,
  tenantId: string,
  raw: unknown,
): Promise<ActionState | null> {
  const parsed = domainIdSchema.safeParse(raw);
  if (!parsed.success) return invalid(parsed.error);

  const domain = await ctx.db.domain.findFirst({
    where: { id: parsed.data.domainId, tenantId, kind: 'custom' },
    select: { id: true, hostname: true, status: true },
  });
  if (!domain) return failure('admin:errors.notFound');
  if (domain.status === 'active') return null;

  const now = new Date();
  await ctx.db.domain.update({
    where: { id: domain.id },
    data: { status: 'verified', verifiedAt: now, lastCheckedAt: now, failureReason: null },
  });

  await auditTenantAction(ctx, tenantId, {
    action: 'domain.force_verified',
    entityType: 'domain',
    entityId: domain.id,
    before: { status: domain.status },
    after: { hostname: domain.hostname, status: 'verified' },
  });

  await invalidateHostname(domain.hostname);
  return null;
}

export async function adminSetPrimaryDomain(
  ctx: AdminContext,
  tenantId: string,
  raw: unknown,
): Promise<ActionState | null> {
  const parsed = domainIdSchema.safeParse(raw);
  if (!parsed.success) return invalid(parsed.error);

  const domain = await ctx.db.domain.findFirst({
    where: { id: parsed.data.domainId, tenantId, kind: 'custom' },
    select: { id: true, hostname: true, isPrimary: true },
  });
  if (!domain) return failure('admin:errors.notFound');
  if (domain.isPrimary) return null;

  await ctx.db.domain.updateMany({ where: { tenantId, kind: 'custom' }, data: { isPrimary: false } });
  await ctx.db.domain.update({ where: { id: domain.id }, data: { isPrimary: true } });

  await auditTenantAction(ctx, tenantId, {
    action: 'domain.primary_changed',
    entityType: 'domain',
    entityId: domain.id,
    after: { hostname: domain.hostname },
  });

  return null;
}

export async function adminRemoveDomain(
  ctx: AdminContext,
  tenantId: string,
  raw: unknown,
): Promise<ActionState | null> {
  const parsed = domainIdSchema.safeParse(raw);
  if (!parsed.success) return invalid(parsed.error);

  const domain = await ctx.db.domain.findFirst({
    where: { id: parsed.data.domainId, tenantId, kind: 'custom' },
    select: { id: true, hostname: true, status: true },
  });
  if (!domain) return failure('admin:errors.notFound');

  await ctx.db.domain.delete({ where: { id: domain.id } });

  await auditTenantAction(ctx, tenantId, {
    action: 'domain.removed',
    entityType: 'domain',
    entityId: domain.id,
    before: { hostname: domain.hostname, status: domain.status, by: 'admin' },
  });

  await invalidateHostname(domain.hostname);
  return null;
}
