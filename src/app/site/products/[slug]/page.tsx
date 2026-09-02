import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { notFound } from 'next/navigation';
import { getEnv } from '@/env';
import { formatAgorot, formatNumber, t } from '@/shared/i18n';
import { CHECKOUT_MAX_QUANTITY } from '@/server/orders/schema';
import { isSizeGuideEmpty, querySizeGuideFor } from '@/server/catalogue';
import { PUBLIC_ACTOR, tenantDb } from '@/server/db';
import { canBool } from '@/server/entitlements';
import { parseSectionConfig, type SectionConfig } from '@/shared/site-contract';
import { beaconDecision } from '@/server/analytics';
import {
  AddToCart,
  analyticsDecision,
  breadcrumbJsonLd,
  buildOrderUrl,
  CheckoutForm,
  JsonLdScript,
  MediaImage,
  productJsonLd,
  StorefrontShell,
  WhatsappOrder,
  normaliseWhatsappNumber,
} from '@/templates';
import { CareDetails } from '@/templates/components/care-details';
import { PriceWithDiscount } from '@/templates/components/discount-badge';
import { SizeGuide } from '@/templates/components/size-guide';
import { VariantPicker } from '@/templates/components/variant-picker';
import { RelatedProductsSection } from '@/templates/sections/related-products';
import { CONSENT_COOKIE, readConsentCookie } from '../../_data/consent';
import { loadStorefrontContext } from '../../_data/context';
import { storefrontMetadata } from '../../_data/metadata';
import {
  queryProductBySlug,
  queryProductDetail,
  queryRelatedProducts,
  variantChoices,
} from '../../_data/products';
import { requireStorefront } from '../../_data/surface';

/**
 * A single product.
 *
 * This is where the WhatsApp order actually happens (Q5): the Arabic message is composed in the
 * visitor's browser from a template rendered here, and their own WhatsApp opens with it. No
 * order row is written, and the page asks the visitor for nothing — no name, no phone, no
 * address. That is the entire reason this storefront's privacy story is short and true.
 */
export const dynamic = 'force-dynamic';

interface PageProps {
  params: Promise<{ slug: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const surface = await requireStorefront();
  const context = await loadStorefrontContext(surface);
  const { slug } = await params;

  /**
   * A suspended site never names the product, and never reads it.
   *
   * The surface layout short-circuits the RENDERED subtree, which is not the same thing: Next
   * builds metadata from the loader tree, as a sibling of the component tree, so a layout that
   * refuses to render `children` does not stop this function running. A suspended storefront was
   * therefore still querying the catalogue on every product URL and putting the product's name in
   * the document title — the one string a crawler or a link preview shows — while the page itself
   * served the Arabic pause notice.
   */
  if (surface.isSuspended) {
    return storefrontMetadata({ context, path: `/products/${slug}`, suspended: true });
  }

  const product = await queryProductBySlug(context.tenantId, slug);
  if (!product) {
    // The render below 404s; the metadata pass just must not advertise a page that is gone.
    return storefrontMetadata({ context, path: `/products/${slug}`, noindex: true });
  }

  return storefrontMetadata({
    context,
    title: product.name,
    description: product.description ?? undefined,
    path: `/products/${product.slug}`,
    imageUrl: product.image?.src ?? null,
    suspended: surface.isSuspended,
  });
}

export default async function ProductPage({ params }: PageProps) {
  const surface = await requireStorefront();
  if (surface.isSuspended) return null;

  const { slug } = await params;
  const context = await loadStorefrontContext(surface);
  const detail = await queryProductDetail(context.tenantId, slug);
  if (!detail) notFound();

  const product = detail.product;

  /**
   * `related_products` is rendered HERE, on the one route where it means anything.
   *
   * The section is also reachable through `SectionList` — a merchant can drag it onto their
   * homepage — and there it renders nothing at all, because no product is passed. That is the
   * section type's stated contract (src/shared/site-contract/sections.ts), and this call site is the
   * other half of it: the config is parsed from `{}` so the block gets its own defaults rather than
   * this page inventing a limit the merchant cannot change.
   */
  const relatedConfig = parseSectionConfig('related_products', {}) as SectionConfig<'related_products'>;
  const related = await queryRelatedProducts(
    context.tenantId,
    { id: product.id, categoryKey: product.categoryKey },
    { limit: relatedConfig.limit, sameCategoryFirst: relatedConfig.sameCategoryFirst },
  );

  /**
   * The size chart, behind axis (a) only.
   *
   * The CAPABILITY (`size_guide`, axis (b)) decides who may EDIT it and says nothing about
   * rendering — `editable_by = admin` still renders on the storefront, which is the contract
   * `src/shared/features.ts` spells out on the `logo` capability and which holds for all eight. So
   * this page asks the feature and nothing else.
   */
  const sizeGuide = (await canBool(context.tenantId, 'size_guide'))
    ? await querySizeGuideFor(
        tenantDb(context.tenantId, PUBLIC_ACTOR),
        context.tenantId,
        detail.categoryId,
      )
    : null;

  const choices = variantChoices(detail);

  /**
   * ONE availability answer for the whole page.
   *
   * `product.available` is the merchant's switch and `detail.stock.inStock` is the count; a product
   * needs both. Computing it once here is what stops the badge, the buy control and the WhatsApp
   * fallback from disagreeing — which they would the first time someone added a stock check to two
   * of the three.
   */
  const sellable = product.available && detail.stock.inStock;

  const consent = readConsentCookie((await cookies()).get(CONSENT_COOKIE)?.value);
  const analytics = analyticsDecision({
    featureEnabled: context.flags.analytics,
    consentGranted: consent.granted,
    websiteId: context.site.umamiWebsiteId,
    scriptUrl: getEnv().UMAMI_SCRIPT_URL,
  });

  const price = formatAgorot(product.priceAgorot);
  const number = normaliseWhatsappNumber(context.site.whatsapp);
  const url = `${context.origin}/products/${product.slug}`;

  /**
   * The message template. Everything except `{qty}` is substituted on the SERVER, so the client
   * component never imports the message catalogue — the storefront bundle stays small and the
   * Arabic copy stays in `messages/ar/storefront.json` where the language gate can see it.
   */
  const messageTemplate = t('storefront', 'order.message', {
    shop: context.site.name,
    product: product.name,
    price,
    url,
  });

  /**
   * Totals pre-formatted per quantity, so the checkout client component never imports the i18n
   * layer (see `checkout-form.tsx`). Ninety-nine short strings is about a kilobyte, against
   * pulling a formatter and a locale into the storefront bundle — and the bundle is what the
   * Fast-3G LCP budget is spent on.
   *
   * Built only when the form will actually render.
   */
  const priceLabels: Record<number, string> = {};
  if (context.flags.payments && sellable) {
    for (let quantity = 1; quantity <= CHECKOUT_MAX_QUANTITY; quantity += 1) {
      priceLabels[quantity] = formatAgorot(product.priceAgorot * quantity);
    }
  }

  /** The WhatsApp fallback link beside the form: quantity 1, since the form owns the stepper. */
  const whatsappHref = number ? buildOrderUrl({ number, template: messageTemplate }, 1) : '';

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
        path: `/products/${product.slug}`,
        productSlug: product.slug,
      }}
      current="products"
    >
      {context.isDemo ? null : (
        <>
          <JsonLdScript data={productJsonLd(context, product)} />
          <JsonLdScript
            data={breadcrumbJsonLd(context.origin, [
              { name: context.site.name, path: '/' },
              { name: t('storefront', 'products.all'), path: '/products' },
              { name: product.name, path: `/products/${product.slug}` },
            ])}
          />
        </>
      )}

      <section className="sf-block">
        <div className="sf-shell">
          <nav className="sf-legal" aria-label={t('storefront', 'products.breadcrumb')}>
            <a href="/">{t('storefront', 'nav.home')}</a>
            <a href="/products">{t('storefront', 'products.all')}</a>
            {product.categoryKey && product.categoryName ? (
              <a href={`/products?category=${encodeURIComponent(product.categoryKey)}`}>
                {product.categoryName}
              </a>
            ) : null}
          </nav>

          <div className="sf-contact" style={{ marginBlockStart: 'var(--t-space-lg)' }}>
            <div>
              <MediaImage
                image={product.image}
                ratio="1 / 1"
                priority
                fallbackLabel={product.name}
                sizes="(max-width: 60rem) 100vw, 45vw"
              />
              {product.images.length > 1 ? (
                <ul
                  className="sf-gallery"
                  aria-label={t('storefront', 'products.gallery')}
                  style={{ marginBlockStart: 'var(--t-space-sm)' }}
                >
                  {product.images.slice(1, 5).map((image, index) => (
                    <li key={`${image.src}-${index}`}>
                      <MediaImage image={image} ratio="1 / 1" sizes="20vw" />
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>

            <div>
              <h1 className="sf-block__title">{product.name}</h1>

              <p className="sf-actions" style={{ marginBlockStart: 'var(--t-space-md)' }}>
                {/* Price, former price and «−19%» — the badge draws itself only when
                    `compareAtPriceAgorot` is strictly greater (see `discountPercent`). */}
                <PriceWithDiscount
                  priceAgorot={product.priceAgorot}
                  compareAtPriceAgorot={detail.compareAtPriceAgorot}
                />
                <span className={sellable ? 'sf-badge' : 'sf-badge sf-badge--off'}>
                  {t('storefront', sellable ? 'order.inStock' : 'order.outOfStock')}
                </span>
                {/*
                  «باقي 2» only when the count is both tracked and meaningful — and only when it is
                  LOW enough to matter. A shop with 400 shirts printing the number turns a scarcity
                  cue into an inventory disclosure, and «باقي 400» persuades nobody.
                */}
                {detail.stock.policy === 'track_and_block' &&
                detail.stock.quantity !== null &&
                detail.stock.quantity > 0 &&
                detail.stock.quantity <= LOW_STOCK_HINT ? (
                  <span className="sf-badge">
                    {t('catalogue', 'stock.left', {
                      count: formatNumber(detail.stock.quantity),
                    })}
                  </span>
                ) : null}
              </p>

              {/*
                THE PICKER SITS ABOVE THE BUY CONTROL, not inside it.

                It cannot be inside: `AddToCart` and `CheckoutForm` are client components owned by
                Phase 8 and neither accepts a variant yet, so a radio group nested in their markup
                would post a `variantId` nothing reads. Above them it does the job it can do today —
                telling a shopper which sizes and colours exist and which are gone, with prices where
                they differ — and the one-line prop each of those two components needs is recorded in
                docs/PHASE-9-track-a-handoff.md.
              */}
              {choices.length > 0 ? (
                <div style={{ marginBlockStart: 'var(--t-space-lg)' }}>
                  <VariantPicker choices={choices} productPriceAgorot={product.priceAgorot} />
                </div>
              ) : null}

              {product.description ? (
                <div className="sf-prose" style={{ marginBlockStart: 'var(--t-space-lg)' }}>
                  {product.description.split(/\n\s*\n/).map((paragraph, index) => (
                    <p key={index}>{paragraph.trim()}</p>
                  ))}
                </div>
              ) : null}

              <dl className="sf-facts" style={{ marginBlockStart: 'var(--t-space-lg)' }}>
                {product.categoryName ? (
                  <div>
                    <dt>{t('storefront', 'products.category')}</dt>
                    <dd>{product.categoryName}</dd>
                  </div>
                ) : null}
                {product.sku ? (
                  <div>
                    <dt>{t('storefront', 'products.sku')}</dt>
                    <dd>{product.sku}</dd>
                  </div>
                ) : null}
                {/*
                  Tags are LINKS back into the filtered catalogue, not decoration — the same plain
                  hrefs the filter row on `/products` uses, so a shopper who likes «قطن» can see the
                  rest of it without the shop needing a search box.
                */}
                {detail.tags.length > 0 ? (
                  <div>
                    <dt>{t('catalogue', 'tags.label')}</dt>
                    <dd>
                      <span className="sf-chips">
                        {detail.tags.map((tag) => (
                          <a
                            key={tag}
                            className="sf-btn sf-btn--ghost"
                            href={`/products?tag=${encodeURIComponent(tag)}`}
                          >
                            {tag}
                          </a>
                        ))}
                      </span>
                    </dd>
                  </div>
                ) : null}
              </dl>

              {/*
                Two disclosures, both native `<details>` and both closed by default: the fabric and
                care block, and the size chart. Order is deliberate — care detail belongs to THIS
                product, the size chart is a reference table for the whole department, so the
                specific one comes first.
              */}
              <div className="sf-actions" style={{ marginBlockStart: 'var(--t-space-lg)' }}>
                <CareDetails careInstructions={detail.careInstructions} />
                {sizeGuide && !isSizeGuideEmpty(sizeGuide) ? (
                  <SizeGuide
                    columns={sizeGuide.columns}
                    rows={sizeGuide.entries.map((entry) => ({
                      id: entry.id,
                      label: entry.label,
                      cells: entry.cells,
                    }))}
                    note={sizeGuide.note}
                  />
                ) : null}
              </div>

              {/*
                CART FIRST (Phase 8), THEN CHECKOUT, THEN WHATSAPP — each branch requiring the
                one before it to be off.

                `flags.cart` is the entire difference Phase 8 adds: when it is false, everything
                below is byte-identical to what it was before this phase — the exact same
                `flags.payments` / `flags.whatsappOrders` three-way split, unchanged.

                CHECKOUT (buy_now) is unaffected by cart being on for a DIFFERENT tenant, and a
                tenant with BOTH somehow on gets the cart control — the newer, more general
                mechanism — rather than two competing forms on one product.
              */}
              <div style={{ marginBlockStart: 'var(--t-space-xl)' }}>
                {context.flags.cart ? (
                  <AddToCart
                    tenantId={context.tenantId}
                    productSlug={product.slug}
                    showQuantity
                    disabled={!sellable}
                    maxQuantity={CHECKOUT_MAX_QUANTITY}
                    labels={{
                      add: t('storefront', 'cart.add'),
                      added: t('storefront', 'cart.added'),
                      quantity: t('storefront', 'order.quantity'),
                      increase: t('storefront', 'order.increase'),
                      decrease: t('storefront', 'order.decrease'),
                      viewCart: t('storefront', 'cart.viewCart'),
                      outOfStock: t('storefront', 'order.outOfStock'),
                    }}
                  />
                ) : context.flags.payments && sellable ? (
                  <>
                    <CheckoutForm
                      productSlug={product.slug}
                      maxQuantity={CHECKOUT_MAX_QUANTITY}
                      priceLabels={priceLabels}
                      instructions={context.checkout?.instructions ?? null}
                      labels={{
                        heading: t('storefront', 'checkout.heading'),
                        name: t('storefront', 'checkout.name'),
                        phone: t('storefront', 'checkout.phone'),
                        note: t('storefront', 'checkout.note'),
                        quantity: t('storefront', 'checkout.quantity'),
                        increase: t('storefront', 'checkout.increase'),
                        decrease: t('storefront', 'checkout.decrease'),
                        total: t('storefront', 'checkout.total'),
                        submit: t('storefront', 'checkout.submit'),
                        submitting: t('storefront', 'checkout.submitting'),
                        privacy: t('storefront', 'checkout.privacy'),
                        instructionsTitle: t('storefront', 'checkout.instructionsTitle'),
                        successTitle: t('storefront', 'checkout.successTitle'),
                        successBody: t('storefront', 'checkout.successBody'),
                        errors: {
                          name: t('storefront', 'checkout.errors.name'),
                          phone: t('storefront', 'checkout.errors.phone'),
                          unavailable: t('storefront', 'checkout.errors.unavailable'),
                          closed: t('storefront', 'checkout.errors.closed'),
                          flooded: t('storefront', 'checkout.errors.flooded'),
                          failed: t('storefront', 'checkout.errors.failed'),
                        },
                      }}
                    />

                    {context.flags.whatsappOrders && number ? (
                      <p className="sf-note" style={{ marginBlockStart: 'var(--t-space-md)' }}>
                        <a
                          className="sf-link"
                          href={whatsappHref}
                          rel="noopener noreferrer"
                          target="_blank"
                        >
                          {t('storefront', 'checkout.orWhatsapp')}
                        </a>
                      </p>
                    ) : null}
                  </>
                ) : context.flags.whatsappOrders && number && sellable ? (
                  <WhatsappOrder
                    number={number}
                    messageTemplate={messageTemplate}
                    showQuantity
                    labels={{
                      order: t('storefront', 'order.whatsapp'),
                      quantity: t('storefront', 'order.quantity'),
                      increase: t('storefront', 'order.increase'),
                      decrease: t('storefront', 'order.decrease'),
                      hint: t('storefront', 'order.hint'),
                    }}
                  />
                ) : (
                  /* Same three-way split as the contact block: out of stock, ordering switched
                     off, or a stored number we cannot dial — and in the last case, print it. */
                  <p className="sf-note">
                    {!sellable
                      ? t('storefront', 'order.outOfStock')
                      : context.flags.whatsappOrders && context.site.whatsapp
                        ? t('storefront', 'order.numberNotUsable', {
                            number: context.site.whatsapp,
                          })
                        : t('storefront', 'order.noNumber')}
                  </p>
                )}
              </div>
            </div>
          </div>
        </div>
      </section>

      {/*
        The hand-rolled "منتجات ثانية من نفس القسم" block that used to live here is now the
        `related_products` SECTION, which is the same markup with three differences that matter: it
        goes through `SectionBlock` (so its heading is an `h2` at the same level as every other
        block, which is what keeps the outline free of axe findings), it picks its column count from
        the number of items rather than leaving a quarter-empty row under the buy button, and it is
        one component instead of two copies — the storefront and the merchant's own arrangement now
        render the same thing.
      */}
      <RelatedProductsSection
        context={context}
        config={relatedConfig}
        product={product}
        products={related}
      />
    </StorefrontShell>
  );
}

/**
 * Above this remaining count, the number is not shown.
 *
 * Scarcity is only informative when it is scarce: «باقي 2» changes a decision and «باقي 400» is an
 * inventory disclosure the merchant did not ask to publish. Five is deliberately NOT the low-stock
 * threshold from `PlatformSettings` — that number is the merchant's reorder alarm, and reusing it
 * here would mean a shop that reorders at forty tells every visitor exactly how many it holds.
 */
const LOW_STOCK_HINT = 5;
