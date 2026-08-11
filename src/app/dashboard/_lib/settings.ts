import { z } from 'zod';
import { can } from '@/server/entitlements';
import { getEnv } from '@/env';
import type { MerchantContext } from './context';
import { audit, refreshStorefront } from './audit';
import { failure, invalid, optionalText, type ActionState } from './validation';

/**
 * The advanced settings — every one of them behind its own feature, and INVISIBLE when the
 * feature is off.
 *
 * "Invisible" rather than "disabled with an upgrade prompt" is the acceptance criterion
 * (docs/PHASES.md: *a merchant without `custom_domain` never sees that section*), and it is the
 * kinder shape too: a basic-plan shop owner has no use for a greyed-out box explaining what
 * they are not paying for on every visit. The sales conversation happens with a human.
 *
 * Domains are Phase 4's, and this screen says so honestly instead of shipping a button that
 * cannot work: it shows the current Domain rows read-only and records a REQUEST. Building the
 * CNAME instructions here would be building Phase 4 in B2's folder, and the verify flow, the
 * cap and the Caddy ask endpoint all live there.
 */

export interface AdvancedFlags {
  customDomain: boolean;
  domainsLimit: number;
  pwa: boolean;
  seoTools: boolean;
  paymentGateway: boolean;
  /** Nothing to show at all — the screen says so rather than rendering an empty page. */
  empty: boolean;
}

export interface DomainRow {
  hostname: string;
  status: 'pending' | 'verified' | 'active' | 'failed';
  isPrimary: boolean;
  kind: string;
}

export interface AdvancedView {
  flags: AdvancedFlags;
  domains: DomainRow[];
  platformHostname: string;
  pwaEnabled: boolean;
  metaTitle: string | null;
  metaDescription: string | null;
}

export async function loadAdvanced(ctx: MerchantContext): Promise<AdvancedView | null> {
  const site = await ctx.db.site.findUnique({
    where: { tenantId: ctx.tenantId },
    select: { pwaEnabled: true, metaTitle: true, metaDescription: true },
  });
  if (!site) return null;

  const [customDomain, domainsLimit, pwa, seoTools, paymentGateway, domains, tenant] =
    await Promise.all([
      can(ctx.tenantId, 'custom_domain'),
      can(ctx.tenantId, 'domains_limit'),
      can(ctx.tenantId, 'pwa'),
      can(ctx.tenantId, 'seo_tools'),
      can(ctx.tenantId, 'payment_gateway'),
      ctx.db.domain.findMany({
        where: { tenantId: ctx.tenantId, kind: 'custom' },
        orderBy: [{ isPrimary: 'desc' }, { hostname: 'asc' }],
        select: { hostname: true, status: true, isPrimary: true, kind: true },
      }),
      ctx.db.tenant.findUnique({ where: { id: ctx.tenantId }, select: { slug: true } }),
    ]);

  const flags: AdvancedFlags = {
    customDomain: customDomain === true,
    domainsLimit: typeof domainsLimit === 'number' ? domainsLimit : 0,
    pwa: pwa === true,
    seoTools: seoTools === true,
    paymentGateway: paymentGateway === true,
    empty: false,
  };
  flags.empty = !flags.customDomain && !flags.pwa && !flags.seoTools && !flags.paymentGateway;

  return {
    flags,
    domains: domains.map((domain) => ({
      hostname: domain.hostname,
      status: domain.status as DomainRow['status'],
      isPrimary: domain.isPrimary,
      kind: domain.kind,
    })),
    platformHostname: tenant ? `${tenant.slug}.${getEnv().DOMAIN}` : '',
    pwaEnabled: site.pwaEnabled,
    metaTitle: site.metaTitle,
    metaDescription: site.metaDescription,
  };
}

// -----------------------------------------------------------------------------
// PWA
// -----------------------------------------------------------------------------

export const pwaSchema = z.object({ enabled: z.boolean() });

export async function savePwa(ctx: MerchantContext, raw: unknown): Promise<ActionState | null> {
  if ((await can(ctx.tenantId, 'pwa')) !== true) return failure('dashboard:errors.forbidden');

  const parsed = pwaSchema.safeParse(raw);
  if (!parsed.success) return invalid(parsed.error);

  await ctx.db.site.update({
    where: { tenantId: ctx.tenantId },
    data: { pwaEnabled: parsed.data.enabled },
  });

  await audit(ctx, {
    action: 'site.pwa_toggled',
    entityType: 'site',
    after: { pwaEnabled: parsed.data.enabled },
  });

  await refreshStorefront(ctx.tenantId);
  return null;
}

// -----------------------------------------------------------------------------
// SEO fields
// -----------------------------------------------------------------------------

export const seoSchema = z.object({
  metaTitle: optionalText(120),
  metaDescription: optionalText(300),
});

/**
 * `seo_tools` gates these EDITABLE fields and nothing else.
 *
 * Baseline metadata — title, description, OG, sitemap, robots, product JSON-LD — ships on every
 * plan from A2 and is not touched here. A basic-plan site is fully indexable; what it does not
 * get is the ability to override the words.
 */
export async function saveSeo(ctx: MerchantContext, raw: unknown): Promise<ActionState | null> {
  if ((await can(ctx.tenantId, 'seo_tools')) !== true) return failure('dashboard:errors.forbidden');

  const parsed = seoSchema.safeParse(raw);
  if (!parsed.success) return invalid(parsed.error);

  await ctx.db.site.update({
    where: { tenantId: ctx.tenantId },
    data: {
      metaTitle: parsed.data.metaTitle ?? null,
      metaDescription: parsed.data.metaDescription ?? null,
    },
  });

  await refreshStorefront(ctx.tenantId);
  return null;
}

// -----------------------------------------------------------------------------
// Custom domain — a REQUEST, not a provisioning flow (Phase 4 owns that)
// -----------------------------------------------------------------------------

export const domainRequestSchema = z.object({
  hostname: z
    .string()
    .trim()
    .toLowerCase()
    .min(4, 'dashboard:errors.invalidValue')
    .max(253, 'dashboard:errors.invalidValue')
    // A hostname, not a URL: a merchant pasting `https://shop.example/` should be told what to
    // type, not have a scheme silently stripped into something that looks accepted.
    .regex(/^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/, 'dashboard:errors.invalidValue'),
});

/**
 * Record the merchant's intent and audit it. Nothing is provisioned.
 *
 * Phase 4 owns verification, the `domains_limit` enforcement, the Caddy on-demand TLS ask and
 * the CNAME runbook. Writing a `pending` Domain row here would put a hostname in a globally
 * unique column that no code can currently verify or clean up — and `domains` is the table
 * `proxy.ts` resolves strangers against.
 */
export async function requestDomain(ctx: MerchantContext, raw: unknown): Promise<ActionState | null> {
  if ((await can(ctx.tenantId, 'custom_domain')) !== true) {
    return failure('dashboard:errors.forbidden');
  }

  const parsed = domainRequestSchema.safeParse(raw);
  if (!parsed.success) return invalid(parsed.error);

  await audit(ctx, {
    action: 'domain.requested',
    entityType: 'domain',
    after: { hostname: parsed.data.hostname },
  });

  return null;
}
