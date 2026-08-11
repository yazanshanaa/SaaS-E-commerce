import { z } from 'zod';
import { withTenantTxn } from '@/server/db';
import { can } from '@/server/entitlements';
import { merchantPaymentsSchema } from '@/server/orders';
import {
  gatewayReadiness,
  readEnabledGateway,
  writeGatewayConfig,
  type GatewayReadiness,
} from '@/server/payments';
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
 * DOMAINS MOVED OUT IN PHASE 4. B2 shipped a "request a domain" stub here, honestly labelled as
 * one, because verification, the cap and the Caddy ask endpoint did not exist yet. They do now,
 * and they are a screen of their own — `/settings/domain` — because connecting a domain is a
 * procedure a merchant follows at another company's control panel, not a field they fill in. What
 * stays here is the LINK, still behind the same feature.
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

export interface AdvancedView {
  flags: AdvancedFlags;
  pwaEnabled: boolean;
  metaTitle: string | null;
  metaDescription: string | null;
  /** Phase 5. The merchant's own selling switch, and why checkout is or is not live. */
  sellingEnabled: boolean;
  paymentInstructions: string | null;
  gatewayReadiness: GatewayReadiness;
}

export async function loadAdvanced(ctx: MerchantContext): Promise<AdvancedView | null> {
  const site = await ctx.db.site.findUnique({
    where: { tenantId: ctx.tenantId },
    select: {
      pwaEnabled: true,
      metaTitle: true,
      metaDescription: true,
      sellingEnabled: true,
    },
  });
  if (!site) return null;

  const [customDomain, domainsLimit, pwa, seoTools, paymentGateway, gateway] = await Promise.all([
    can(ctx.tenantId, 'custom_domain'),
    can(ctx.tenantId, 'domains_limit'),
    can(ctx.tenantId, 'pwa'),
    can(ctx.tenantId, 'seo_tools'),
    can(ctx.tenantId, 'payment_gateway'),
    readEnabledGateway(ctx.db, ctx.tenantId),
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
    pwaEnabled: site.pwaEnabled,
    metaTitle: site.metaTitle,
    metaDescription: site.metaDescription,
    sellingEnabled: site.sellingEnabled,
    paymentInstructions: gateway?.instructions ?? null,
    gatewayReadiness: gatewayReadiness({
      featureOn: paymentGateway === true,
      state: gateway,
    }),
  };
}

// -----------------------------------------------------------------------------
// Payments — the MERCHANT'S half (Phase 5)
// -----------------------------------------------------------------------------

/**
 * What the merchant controls, and what they deliberately do not.
 *
 * They own the SELLING SWITCH (`Site.sellingEnabled`) and the Arabic instructions their customer
 * reads after ordering. They do not own the provider or its keys: those are a commercial
 * credential issued to a registered entity, collected during onboarding, and typing one wrong
 * takes the shop's checkout down. That split is why this function writes `Site.sellingEnabled` and
 * `GatewayConfig.config.instructions` and touches nothing else.
 *
 * `Site.sellingEnabled` has existed since Phase 1 with no write path anywhere — A2 reads it for
 * the legal footer. This is it.
 */
export async function savePayments(
  ctx: MerchantContext,
  raw: unknown,
): Promise<ActionState | null> {
  if ((await can(ctx.tenantId, 'payment_gateway')) !== true) {
    return failure('dashboard:errors.forbidden');
  }

  const parsed = merchantPaymentsSchema.safeParse(raw);
  if (!parsed.success) return invalid(parsed.error);

  const gateway = await readEnabledGateway(ctx.db, ctx.tenantId);
  const readiness = gatewayReadiness({ featureOn: true, state: gateway });

  /**
   * Turning selling ON needs a gateway that can actually take an order. Turning it OFF is always
   * allowed — a merchant closing their own checkout must never be blocked by the state of a
   * provider, which is exactly the moment they most want it closed.
   */
  if (parsed.data.sellingEnabled && (readiness !== 'ready' || !gateway)) {
    return failure('dashboard:orders.errors.noGateway');
  }

  await ctx.db.site.update({
    where: { tenantId: ctx.tenantId },
    data: { sellingEnabled: parsed.data.sellingEnabled },
  });

  if (gateway) {
    await withTenantTxn(
      ctx.tenantId,
      (tx) =>
        writeGatewayConfig(tx, {
          tenantId: ctx.tenantId,
          provider: gateway.provider,
          // No `credentials` key at all: this path must not be able to touch them even by
          // accident, and `writeGatewayConfig` leaves the stored blob alone when it is absent.
          instructions: parsed.data.instructions ?? null,
        }),
      { actor: ctx.actor },
    );
  }

  await audit(ctx, {
    action: 'site.selling_toggled',
    entityType: 'site',
    after: { sellingEnabled: parsed.data.sellingEnabled },
  });

  await refreshStorefront(ctx.tenantId);
  return null;
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
// Custom domain
// -----------------------------------------------------------------------------
//
// Phase 4 owns the whole flow, in `src/app/dashboard/_lib/domains.ts` and `src/server/domains`.
// B2's "request a domain" stub is gone: it wrote nothing but an audit row, and leaving it beside
// a real screen would have given a merchant two boxes for the same job, one of which did nothing.
