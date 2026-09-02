import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { notFound } from 'next/navigation';
import { getEnv } from '@/env';
import { t } from '@/shared/i18n';
import { analyticsDecision, StorefrontShell, TrackingView } from '@/templates';
import { CONSENT_COOKIE, readConsentCookie } from '../../_data/consent';
import { loadStorefrontContext } from '../../_data/context';
import { storefrontMetadata } from '../../_data/metadata';
import { requireStorefront } from '../../_data/surface';

/**
 * The public order-tracking page (Phase 8, items 5 and 6). Renders the same phone-last-4 gate
 * for every tracking code, valid or not — `TrackingView`'s own lookup call already returns the
 * same generic failure for a wrong code and a right-code-wrong-phone, so this page must not leak
 * the difference either by rendering something different for a code that turns out not to
 * exist. There is nothing to check server-side before the gate: the code alone proves nothing.
 */
export const dynamic = 'force-dynamic';

interface PageProps {
  params: Promise<{ trackingCode: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const surface = await requireStorefront();
  const context = await loadStorefrontContext(surface);
  const { trackingCode } = await params;
  return storefrontMetadata({ context, path: `/order/${trackingCode}`, noindex: true });
}

export default async function OrderTrackingPage({ params }: PageProps) {
  const surface = await requireStorefront();
  if (surface.isSuspended) return null;

  const context = await loadStorefrontContext(surface);
  if (!context.flags.cart) notFound();

  const { trackingCode } = await params;

  const consent = readConsentCookie((await cookies()).get(CONSENT_COOKIE)?.value);
  const analytics = analyticsDecision({
    featureEnabled: context.flags.analytics,
    consentGranted: consent.granted,
    websiteId: context.site.umamiWebsiteId,
    scriptUrl: getEnv().UMAMI_SCRIPT_URL,
  });

  return (
    <StorefrontShell context={context} analytics={analytics} consentAnswered={consent.answered}>
      <section className="sf-block">
        <div className="sf-shell">
          <TrackingView
            trackingCode={trackingCode}
            labels={{
              gateTitle: t('storefront', 'tracking.gateTitle'),
              gateHint: t('storefront', 'tracking.gateHint'),
              phoneLast4: t('storefront', 'tracking.phoneLast4'),
              gateSubmit: t('storefront', 'tracking.gateSubmit'),
              gateSubmitting: t('storefront', 'tracking.gateSubmitting'),
              notFound: t('storefront', 'tracking.notFound'),
              statuses: {
                new: t('storefront', 'tracking.statuses.new'),
                confirmed: t('storefront', 'tracking.statuses.confirmed'),
                preparing: t('storefront', 'tracking.statuses.preparing'),
                delivered: t('storefront', 'tracking.statuses.delivered'),
                cancelled: t('storefront', 'tracking.statuses.cancelled'),
              },
              orderNumber: t('storefront', 'tracking.orderNumber'),
              items: t('storefront', 'tracking.items'),
              subtotal: t('storefront', 'cart.subtotal'),
              discount: t('storefront', 'cart.discount'),
              deliveryFee: t('storefront', 'cart.deliveryFee'),
              total: t('storefront', 'cart.total'),
              deliveryArea: t('storefront', 'cart.deliveryArea'),
              deliveryAddress: t('storefront', 'cart.deliveryAddress'),
              paymentMethod: t('storefront', 'cart.paymentMethod'),
              paymentMethods: {
                cod: t('storefront', 'cart.paymentMethods.cod'),
                pickup: t('storefront', 'cart.paymentMethods.pickup'),
                gateway: t('storefront', 'cart.paymentMethods.gateway'),
              },
              editUntil: t('storefront', 'tracking.editUntil'),
              edit: t('storefront', 'tracking.edit'),
              cancel: t('storefront', 'tracking.cancel'),
              editHeading: t('storefront', 'tracking.editHeading'),
              name: t('storefront', 'checkout.name'),
              phone: t('storefront', 'checkout.phone'),
              note: t('storefront', 'checkout.note'),
              saveEdit: t('storefront', 'tracking.saveEdit'),
              saving: t('storefront', 'tracking.saving'),
              cancelHeading: t('storefront', 'tracking.cancelHeading'),
              cancelReasonLabel: t('storefront', 'tracking.cancelReasonLabel'),
              confirmCancel: t('storefront', 'tracking.confirmCancel'),
              cancelling: t('storefront', 'tracking.cancelling'),
              cancelledNotice: t('storefront', 'tracking.cancelledNotice'),
              back: t('storefront', 'tracking.back'),
              errors: {
                not_found: t('storefront', 'tracking.notFound'),
                window_closed: t('storefront', 'tracking.windowClosed'),
                invalid: t('storefront', 'checkout.errors.failed'),
                failed: t('storefront', 'checkout.errors.failed'),
              },
            }}
          />
        </div>
      </section>
    </StorefrontShell>
  );
}
