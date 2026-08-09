import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  isDemoTokenValid,
  parseHostname,
  resolveTenantByHostname,
} from '@/server/tenancy';
import { resolveExportDownload } from '@/server/export';
import { randomToken } from '@/server/crypto';
import { adminDb, createTenant, resetTenants, type SeededTenant } from '../helpers/factories';

/**
 * Hostname resolution, the demo-token branch (Q8), and the export link's resolution rules
 * (Q18) — the three pre-tenant-context lookups, all of which run through narrow named policies
 * rather than through a hole in the generic template.
 */

let shop: SeededTenant;
let demo: SeededTenant;
let demoToken: string;

beforeAll(async () => {
  await resetTenants();
  shop = await createTenant({ slug: 'resolve-shop' });
  demo = await createTenant({ slug: 'resolve-demo', isDemo: true, planKey: 'demo' });

  demoToken = randomToken();
  await adminDb().demoLink.create({ data: { tenantId: demo.id, token: demoToken } });
});

afterAll(async () => {
  await resetTenants();
});

describe('hostname parsing', () => {
  it('recognises the three platform surfaces', () => {
    expect(parseHostname('admin.souqbartaa.test').surface).toBe('admin');
    expect(parseHostname('app.souqbartaa.test').surface).toBe('app');

    const storefront = parseHostname('resolve-shop.souqbartaa.test');
    expect(storefront.surface).toBe('storefront');
    expect(storefront.slug).toBe('resolve-shop');
  });

  it('strips the port and lowercases', () => {
    expect(parseHostname('APP.SouqBartaa.test:3000').surface).toBe('app');
  });

  it('treats a deeper label as unknown, not as a slug', () => {
    // `a.b.{DOMAIN}` is a mistake, not a tenant. Guessing here would resolve a wildcard
    // certificate onto an arbitrary tenant.
    expect(parseHostname('a.b.souqbartaa.test').surface).toBe('unknown');
  });

  it('refuses reserved subdomains as slugs', () => {
    expect(parseHostname('n8n.souqbartaa.test').surface).toBe('unknown');
    expect(parseHostname('umami.souqbartaa.test').surface).toBe('unknown');
    expect(parseHostname('www.souqbartaa.test').surface).toBe('unknown');
  });

  it('treats anything off-domain as a candidate custom domain', () => {
    const custom = parseHostname('shop.example.com');
    expect(custom.surface).toBe('storefront');
    expect(custom.isCustomDomain).toBe(true);
  });
});

describe('resolveTenantByHostname', () => {
  it('resolves a platform storefront subdomain', async () => {
    const context = await resolveTenantByHostname('resolve-shop.souqbartaa.test');
    expect(context?.tenantId).toBe(shop.id);
    expect(context?.isDemo).toBe(false);
    expect(context?.isSuspended).toBe(false);
  });

  it('resolves Tenant.isDemo into the context — the canonical predicate', async () => {
    const context = await resolveTenantByHostname('resolve-demo.souqbartaa.test');
    expect(context?.isDemo).toBe(true);
  });

  it('returns null for an unknown hostname — never a fallback tenant', async () => {
    expect(await resolveTenantByHostname('nobody.souqbartaa.test')).toBeNull();
    expect(await resolveTenantByHostname('unclaimed.example.com')).toBeNull();
  });

  it('resolves a verified custom domain and ignores a pending one', async () => {
    await adminDb().domain.create({
      data: { tenantId: shop.id, hostname: 'pending.example.com', status: 'pending' },
    });
    await adminDb().domain.create({
      data: { tenantId: shop.id, hostname: 'live.example.com', status: 'active' },
    });

    expect(await resolveTenantByHostname('pending.example.com')).toBeNull();
    expect((await resolveTenantByHostname('live.example.com'))?.tenantId).toBe(shop.id);
  });

  it('reports a suspended storefront so the pause page can be served', async () => {
    const closed = await createTenant({ slug: 'closed-shop', status: 'suspended' });
    const context = await resolveTenantByHostname('closed-shop.souqbartaa.test');
    expect(context?.tenantId).toBe(closed.id);
    expect(context?.isSuspended).toBe(true);
  });
});

describe('the demo-token branch (Q8)', () => {
  it('accepts a live token for its own tenant', async () => {
    expect(await isDemoTokenValid(demo.id, demoToken)).toBe(true);
  });

  it('rejects a missing token — this is what serves the Arabic rejection page', async () => {
    expect(await isDemoTokenValid(demo.id, undefined)).toBe(false);
    expect(await isDemoTokenValid(demo.id, '')).toBe(false);
  });

  it('rejects another tenant’s token', async () => {
    const other = randomToken();
    await adminDb().demoLink.create({ data: { tenantId: shop.id, token: other } });
    expect(await isDemoTokenValid(demo.id, other)).toBe(false);
  });

  it('rejects a revoked token', async () => {
    const revoked = randomToken();
    await adminDb().demoLink.create({
      data: { tenantId: demo.id, token: revoked, revokedAt: new Date() },
    });
    expect(await isDemoTokenValid(demo.id, revoked)).toBe(false);
  });

  it('rejects an expired token', async () => {
    const expired = randomToken();
    await adminDb().demoLink.create({
      data: { tenantId: demo.id, token: expired, expiresAt: new Date(Date.now() - 1_000) },
    });
    expect(await isDemoTokenValid(demo.id, expired)).toBe(false);
  });
});

describe('the export download token (Q18)', () => {
  it('rejects a token that resolves to nothing', async () => {
    const result = await resolveExportDownload(randomToken());
    expect(result.ok).toBe(false);
  });

  it('rejects a short or empty token without touching the database', async () => {
    expect((await resolveExportDownload('')).ok).toBe(false);
    expect((await resolveExportDownload('abc')).ok).toBe(false);
  });

  it('reports not_ready while the artifact is still being built', async () => {
    const suspended = await createTenant({ slug: 'export-pending', status: 'suspended' });
    const subscription = await adminDb().subscription.findUniqueOrThrow({
      where: { tenantId: suspended.id },
      select: { exportDownloadToken: true },
    });

    // Suspension commits first and the export runs in a job. Never promise a copy that does
    // not exist yet.
    const result = await resolveExportDownload(subscription.exportDownloadToken!);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('not_ready');
  });

  it('resolves once the artifact exists', async () => {
    const suspended = await createTenant({ slug: 'export-ready', status: 'suspended' });
    const subscription = await adminDb().subscription.update({
      where: { tenantId: suspended.id },
      data: { exportKey: `tenants/${suspended.id}/_exports/artifact.zip`, exportGeneratedAt: new Date() },
      select: { exportDownloadToken: true },
    });

    const result = await resolveExportDownload(subscription.exportDownloadToken!);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.tenantId).toBe(suspended.id);
      expect(result.alreadyDownloaded).toBe(false);
    }
  });

  it('stops resolving the moment the token is cleared — reactivation revokes instantly', async () => {
    const suspended = await createTenant({ slug: 'export-revoked', status: 'suspended' });
    const before = await adminDb().subscription.update({
      where: { tenantId: suspended.id },
      data: { exportKey: 'tenants/x/_exports/a.zip' },
      select: { exportDownloadToken: true },
    });

    expect((await resolveExportDownload(before.exportDownloadToken!)).ok).toBe(true);

    await adminDb().subscription.update({
      where: { tenantId: suspended.id },
      data: { exportDownloadToken: null },
    });

    // A presigned URL could not have been taken back. This one is gone in one column write.
    expect((await resolveExportDownload(before.exportDownloadToken!)).ok).toBe(false);
  });

  it('stops resolving once the retention window closes', async () => {
    const suspended = await createTenant({ slug: 'export-expired', status: 'suspended' });
    const row = await adminDb().subscription.update({
      where: { tenantId: suspended.id },
      data: {
        exportKey: 'tenants/x/_exports/a.zip',
        retentionUntil: new Date(Date.now() - 1_000),
      },
      select: { exportDownloadToken: true },
    });

    expect((await resolveExportDownload(row.exportDownloadToken!)).ok).toBe(false);
  });

  it('does not resolve for an ACTIVE subscription', async () => {
    const live = await createTenant({ slug: 'export-active' });
    const token = randomToken();

    await adminDb().subscription.update({
      where: { tenantId: live.id },
      data: { exportDownloadToken: token, exportKey: 'tenants/x/_exports/a.zip' },
    });

    // A live account must not carry a working link to a standing snapshot of its catalogue.
    expect((await resolveExportDownload(token)).ok).toBe(false);
  });
});
