import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { notFound } from 'next/navigation';
import { getEnv } from '@/env';
import { t } from '@/shared/i18n';
import { beaconDecision } from '@/server/analytics';
import { analyticsDecision, CartView, StorefrontShell } from '@/templates';
import { CONSENT_COOKIE, readConsentCookie } from '../_data/consent';
import { loadStorefrontContext } from '../_data/context';
import { storefrontMetadata } from '../_data/metadata';
import { requireStorefront } from '../_data/surface';

/**
 * The cart page (Phase 8, item 2): line items, a coupon field, the delivery fee and the total.
 *
 * `notFound()` when `flags.cart` is false — "all cart/checkout/order routes return 404" (the
 * change plan's own rule) applies to this customer-facing page exactly as it does to the API
 * routes underneath it: a bookmarked `/cart` from before an admin turned the feature off must not
 * keep working.
 */
export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const surface = await requireStorefront();
  const context = await loadStorefrontContext(surface);
  return storefrontMetadata({ context, path: '/cart', noindex: true });
}

export default async function CartPage() {
  const surface = await requireStorefront();
  if (surface.isSuspended) return null;

  const context = await loadStorefrontContext(surface);
  if (!context.flags.cart) notFound();

  const consent = readConsentCookie((await cookies()).get(CONSENT_COOKIE)?.value);
  const analytics = analyticsDecision({
    featureEnabled: context.flags.analytics,
    consentGranted: consent.granted,
    websiteId: context.site.umamiWebsiteId,
    scriptUrl: getEnv().UMAMI_SCRIPT_URL,
  });

  return (
    <StorefrontShell
      context={context}
      analytics={analytics}
      consentAnswered={consent.answered}
      /*
        Phase 9. Both gates — the feature and the consent cookie — resolved by the page, because
        only the page holds the cookie. `path` is the route's own shape rather than
        `location.pathname`, which would report the proxy's internal `/site/…` rewrite.
      */
      beacon={{
        enabled: beaconDecision({
          featureEnabled: context.flags.visitorAnalytics,
          consentGranted: consent.granted,
        }).enabled,
        path: '/cart',
      }}
    >
      <section className="sf-block">
        <div className="sf-shell">
          <CartView
            tenantId={context.tenantId}
            labels={{
              title: t('storefront', 'cart.pageTitle'),
              empty: t('storefront', 'cart.empty'),
              continueShopping: t('storefront', 'cart.continueShopping'),
              quantity: t('storefront', 'order.quantity'),
              increase: t('storefront', 'order.increase'),
              decrease: t('storefront', 'order.decrease'),
              remove: t('storefront', 'cart.remove'),
              subtotal: t('storefront', 'cart.subtotal'),
              discount: t('storefront', 'cart.discount'),
              deliveryFee: t('storefront', 'cart.deliveryFee'),
              total: t('storefront', 'cart.total'),
              freeDelivery: t('storefront', 'cart.freeDelivery'),
              couponLabel: t('storefront', 'cart.couponLabel'),
              couponPlaceholder: t('storefront', 'cart.couponPlaceholder'),
              couponApply: t('storefront', 'cart.couponApply'),
              couponRemove: t('storefront', 'cart.couponRemove'),
              couponApplied: t('storefront', 'cart.couponApplied'),
              checkout: t('storefront', 'cart.checkout'),
              unavailable: t('storefront', 'order.outOfStock'),
              minOrder: t('storefront', 'cart.minOrder'),
              loading: t('storefront', 'cart.loading'),
              minOrderMessage: t('storefront', 'cart.minOrderMessage'),
              couponErrors: {
                not_found: t('storefront', 'cart.couponErrors.notFound'),
                inactive: t('storefront', 'cart.couponErrors.invalid'),
                not_started: t('storefront', 'cart.couponErrors.invalid'),
                expired: t('storefront', 'cart.couponErrors.expired'),
                below_minimum: t('storefront', 'cart.couponErrors.belowMinimum'),
                max_uses_reached: t('storefront', 'cart.couponErrors.maxUses'),
                already_used: t('storefront', 'cart.couponErrors.alreadyUsed'),
                not_applicable: t('storefront', 'cart.couponErrors.notApplicable'),
                invalid: t('storefront', 'cart.couponErrors.invalid'),
              },
            }}
          />
        </div>
      </section>
    </StorefrontShell>
  );
}
