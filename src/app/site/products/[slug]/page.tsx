import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { notFound } from 'next/navigation';
import { getEnv } from '@/env';
import { formatAgorot, t } from '@/shared/i18n';
import {
  analyticsDecision,
  breadcrumbJsonLd,
  JsonLdScript,
  MediaImage,
  ProductCard,
  productJsonLd,
  StorefrontShell,
  WhatsappOrder,
  normaliseWhatsappNumber,
} from '@/templates';
import { CONSENT_COOKIE, readConsentCookie } from '../../_data/consent';
import { loadStorefrontContext } from '../../_data/context';
import { storefrontMetadata } from '../../_data/metadata';
import { queryProductBySlug, queryProducts } from '../../_data/products';
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
  const product = await queryProductBySlug(context.tenantId, slug);
  if (!product) notFound();

  const related = product.categoryKey
    ? (await queryProducts(context.tenantId, { categoryKey: product.categoryKey, take: 5 })).filter(
        (entry) => entry.id !== product.id,
      )
    : [];

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

  return (
    <StorefrontShell
      context={context}
      analytics={analytics}
      consentAnswered={consent.answered}
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
                <span className="sf-price">{price}</span>
                <span className={product.available ? 'sf-badge' : 'sf-badge sf-badge--off'}>
                  {t('storefront', product.available ? 'order.inStock' : 'order.outOfStock')}
                </span>
              </p>

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
              </dl>

              <div style={{ marginBlockStart: 'var(--t-space-xl)' }}>
                {context.flags.whatsappOrders && number && product.available ? (
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
                    {!product.available
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

      {related.length > 0 ? (
        <section className="sf-block">
          <div className="sf-shell">
            <div className="sf-block__head">
              <h2 className="sf-block__title">{t('storefront', 'products.moreFrom')}</h2>
            </div>
            <div className="sf-grid">
              {related.slice(0, 4).map((entry) => (
                <ProductCard key={entry.id} product={entry} template={context.template} />
              ))}
            </div>
          </div>
        </section>
      ) : null}
    </StorefrontShell>
  );
}
