import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { notFound } from 'next/navigation';
import { getEnv } from '@/env';
import { PUBLIC_ACTOR, tenantDb } from '@/server/db';
import { getOrderSettings } from '@/server/orders';
import { t } from '@/shared/i18n';
import { beaconDecision } from '@/server/analytics';
import { analyticsDecision, CheckoutView, StorefrontShell, normaliseWhatsappNumber } from '@/templates';
import { CONSENT_COOKIE, readConsentCookie } from '../_data/consent';
import { loadStorefrontContext } from '../_data/context';
import { storefrontMetadata } from '../_data/metadata';
import { requireStorefront } from '../_data/surface';

/**
 * Cart checkout (Phase 8, item 4). `OrderSettings` is read directly here rather than through the
 * cached `StorefrontContext` — unlike the mostly-static content that unit caches, payment
 * methods and delivery areas are exactly the kind of thing a merchant changes and expects to see
 * reflected on the very next page view, the same reasoning that already keeps axis (a)/(b)
 * resolution out of that cache.
 */
export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const surface = await requireStorefront();
  const context = await loadStorefrontContext(surface);
  return storefrontMetadata({ context, path: '/checkout', noindex: true });
}

export default async function CheckoutPage() {
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

  const db = tenantDb(context.tenantId, PUBLIC_ACTOR);
  const settings = await getOrderSettings(db, context.tenantId);
  const whatsappNumber = normaliseWhatsappNumber(context.site.whatsapp);

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
        path: '/checkout',
      }}
    >
      <section className="sf-block">
        <div className="sf-shell">
          <CheckoutView
            tenantId={context.tenantId}
            whatsappNumber={whatsappNumber}
            paymentMethods={settings.paymentMethods}
            deliveryAreas={settings.deliveryAreas}
            labels={{
              heading: t('storefront', 'checkout.heading'),
              name: t('storefront', 'checkout.name'),
              phone: t('storefront', 'checkout.phone'),
              note: t('storefront', 'checkout.note'),
              deliveryArea: t('storefront', 'cart.deliveryArea'),
              deliveryAreaPlaceholder: t('storefront', 'cart.deliveryAreaPlaceholder'),
              deliveryAddress: t('storefront', 'cart.deliveryAddress'),
              paymentMethod: t('storefront', 'cart.paymentMethod'),
              paymentMethods: {
                cod: t('storefront', 'cart.paymentMethods.cod'),
                pickup: t('storefront', 'cart.paymentMethods.pickup'),
                gateway: t('storefront', 'cart.paymentMethods.gateway'),
              },
              submit: t('storefront', 'cart.checkoutSubmit'),
              submitting: t('storefront', 'checkout.submitting'),
              privacy: t('storefront', 'cart.checkoutPrivacy'),
              emptyCart: t('storefront', 'cart.empty'),
              backToCart: t('storefront', 'cart.backToCart'),
              successTitle: t('storefront', 'cart.successTitle'),
              successBody: t('storefront', 'cart.successBody'),
              trackingLabel: t('storefront', 'cart.trackingLabel'),
              trackingLink: t('storefront', 'cart.trackingLink'),
              copyLink: t('storefront', 'cart.copyLink'),
              copied: t('storefront', 'cart.copied'),
              whatsappShare: t('storefront', 'cart.whatsappShare'),
              whatsappMessageTemplate: t('storefront', 'cart.whatsappMessageTemplate', {
                shop: context.site.name,
              }),
              errors: {
                name: t('storefront', 'checkout.errors.name'),
                phone: t('storefront', 'checkout.errors.phone'),
                failed: t('storefront', 'checkout.errors.failed'),
                closed: t('storefront', 'checkout.errors.closed'),
                flooded: t('storefront', 'checkout.errors.flooded'),
                cart_disabled: t('storefront', 'checkout.errors.closed'),
                ordering_paused: t('storefront', 'cart.errors.orderingPaused'),
                empty_cart: t('storefront', 'cart.empty'),
                item_not_found: t('storefront', 'cart.errors.itemUnavailable'),
                item_unavailable: t('storefront', 'cart.errors.itemUnavailable'),
                below_min_order: t('storefront', 'cart.errors.belowMinOrder'),
                payment_method_unavailable: t('storefront', 'cart.errors.paymentMethodUnavailable'),
                delivery_area_required: t('storefront', 'cart.errors.deliveryAreaRequired'),
                delivery_address_required: t('storefront', 'cart.errors.deliveryAddressRequired'),
                invalid: t('storefront', 'checkout.errors.failed'),
                couponInvalid: t('storefront', 'cart.couponErrors.invalid'),
              },
            }}
          />
        </div>
      </section>
    </StorefrontShell>
  );
}
