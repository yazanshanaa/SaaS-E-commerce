import { formatAgorot } from '@/shared/i18n';
import { st } from '../i18n';
import type { TemplateDefinition } from '../types';
import type { StorefrontProduct } from '../view-model';
import { MediaImage } from './media-image';

/**
 * The product card, in three genuinely different shapes.
 *
 * This is where "three templates, not three palettes" is actually earned: the MARKUP differs,
 * not only the CSS. `warsheh` renders a specification table because its customer is comparing
 * forty items on price and availability; `neon-souq` puts the name over the base of the
 * photograph because its customer is shopping with their eyes; `diwan` frames the picture and
 * puts the price on a warm plate.
 *
 * One anchor per card, wrapping everything. A second link inside the card (a "details" link
 * beside a linked image) is the most common way a product grid picks up an axe finding and the
 * most common way it becomes tedious with a screen reader.
 */

export interface ProductCardProps {
  product: StorefrontProduct;
  template: TemplateDefinition;
  /** The first row of the first grid may load eagerly; everything else must not. */
  priority?: boolean;
  /**
   * `products_grid.showPrices = false` — a catalogue rather than a shop. The price is then
   * omitted entirely rather than shown as "على الطلب": a placeholder price is a price a
   * customer will quote back at the merchant.
   */
  showPrice?: boolean;
}

export function ProductCard({
  product,
  template,
  priority = false,
  showPrice = true,
}: ProductCardProps) {
  const variant = template.layout.productCard;
  const price = formatAgorot(product.priceAgorot);

  return (
    <article className={`sf-card sf-card--${variant}`}>
      <a className="sf-card__link" href={`/products/${product.slug}`}>
        <div className="sf-card__media">
          <MediaImage
            image={product.image}
            priority={priority}
            fallbackLabel={product.name}
            sizes="(max-width: 40rem) 50vw, 25vw"
          />
        </div>

        <div className="sf-card__body">
          <h3 className="sf-card__name">{product.name}</h3>

          {variant === 'spec' ? (
            <SpecBody product={product} price={showPrice ? price : null} />
          ) : (
            <StandardBody
              product={product}
              price={showPrice ? price : null}
              showDescription={variant === 'framed'}
            />
          )}
        </div>
      </a>
    </article>
  );
}

function StandardBody({
  product,
  price,
  showDescription,
}: {
  product: StorefrontProduct;
  price: string | null;
  showDescription: boolean;
}) {
  return (
    <>
      {showDescription && product.description ? (
        <p className="sf-card__desc">{product.description}</p>
      ) : null}

      <div className="sf-card__foot">
        {price ? <span className="sf-price">{price}</span> : <span />}
        {product.available ? (
          product.badge ? (
            <span className="sf-badge">{product.badge}</span>
          ) : null
        ) : (
          <span className="sf-badge sf-badge--off">{st('order.outOfStock')}</span>
        )}
      </div>
    </>
  );
}

/**
 * The `warsheh` body: a definition list, because that is what it is. A table element would
 * promise column relationships that do not exist between two unrelated rows.
 */
function SpecBody({ product, price }: { product: StorefrontProduct; price: string | null }) {
  return (
    <dl className="sf-card__spec">
      {price ? (
        <>
          <dt>{st('products.price')}</dt>
          <dd className="sf-price">{price}</dd>
        </>
      ) : null}

      <dt>{st('products.availability')}</dt>
      <dd>{product.available ? st('order.inStock') : st('order.outOfStock')}</dd>

      {product.sku ? (
        <>
          <dt>{st('products.sku')}</dt>
          <dd>{product.sku}</dd>
        </>
      ) : null}
    </dl>
  );
}
