import { formatAgorot, formatNumber, translator } from '@/shared/i18n';

/**
 * «−19%» — the price-before-discount badge.
 *
 * `catalogue` rather than `storefront`: Phase 9 gave each track its own namespace so five
 * parallel tracks do not all append to one forty-kilobyte file (see src/shared/i18n/index.ts).
 * This is a SERVER component, so it may call the translator directly — the rule that client
 * components receive already-translated labels as props (components/announcement-bar.tsx) does
 * not apply, and would cost a prop for every string here.
 */
const ct = translator('catalogue');

/**
 * The discount, in whole percent, or null when there is no discount to show.
 *
 * INTEGER MATH THROUGHOUT, and round HALF-UP. `Math.round((diff / compare) * 100)` would be the
 * obvious spelling and it is the one to avoid: it puts a float on the path between two `Int`
 * columns, and IEEE-754 rounds a value that lands exactly on .5 to whichever side the binary
 * fraction happened to fall — so two products with arithmetically identical discounts can print
 * different numbers. `floor((diff * 200 + compare) / (2 * compare))` is `floor(x + 1/2)` with
 * every intermediate an integer, which is half-up by construction.
 *
 * Null is returned rather than 0 for "no discount", because the two are different instructions
 * to the caller: zero would be a badge reading «−0%».
 */
export function discountPercent(
  priceAgorot: number,
  compareAtPriceAgorot: number | null | undefined,
): number | null {
  if (compareAtPriceAgorot === null || compareAtPriceAgorot === undefined) return null;
  // Strictly greater, per the schema comment on `Product.compareAtPriceAgorot`: a merchant
  // mid-edit is allowed to be briefly inconsistent, and the storefront simply declines to draw a
  // badge for it rather than printing «−0%» or a negative discount.
  if (compareAtPriceAgorot <= priceAgorot) return null;
  if (compareAtPriceAgorot <= 0) return null;

  const difference = compareAtPriceAgorot - priceAgorot;
  const percent = Math.floor((difference * 200 + compareAtPriceAgorot) / (2 * compareAtPriceAgorot));

  // A 100% discount is a free product, which is a data-entry mistake far more often than an
  // offer; it still renders, because refusing to draw it would hide the mistake from the
  // merchant looking at their own storefront.
  return percent > 0 ? percent : null;
}

export interface DiscountBadgeProps {
  priceAgorot: number;
  compareAtPriceAgorot: number | null | undefined;
}

/** The badge on its own — what a product CARD shows over the photograph. */
export function DiscountBadge({ priceAgorot, compareAtPriceAgorot }: DiscountBadgeProps) {
  const percent = discountPercent(priceAgorot, compareAtPriceAgorot);
  if (percent === null) return null;

  const digits = formatNumber(percent);

  return (
    /*
      The visible text is «−19%» — a glyph and two digits, which is what a shopper scans for. The
      accessible name spells it out in Arabic, because «ناقص تسعة عشر بالمئة» read off a bare
      minus sign is not something a screen reader can be relied on to produce.
    */
    <span className="sf-badge" aria-label={ct('pricing.discountLabel', { percent: digits })}>
      {ct('pricing.discountBadge', { percent: digits })}
    </span>
  );
}

export interface PriceWithDiscountProps {
  priceAgorot: number;
  compareAtPriceAgorot: number | null | undefined;
}

/**
 * The price row: what it costs, what it cost, and by how much less.
 *
 * The struck-through former price is `aria-hidden`. That is a deliberate accessibility call
 * rather than an omission: the badge already states «خصم 19%» and the current price is
 * announced, so the old figure adds no information and its absence prevents the row from being
 * read as "56 shekels 69 shekels" — two prices in a row, with nothing in the audio to say which
 * one is being charged.
 */
export function PriceWithDiscount({ priceAgorot, compareAtPriceAgorot }: PriceWithDiscountProps) {
  const percent = discountPercent(priceAgorot, compareAtPriceAgorot);

  return (
    <>
      <span className="sf-price">{formatAgorot(priceAgorot)}</span>
      {percent === null ? null : (
        <>
          <s className="sf-price sf-price--muted" aria-hidden="true">
            {formatAgorot(compareAtPriceAgorot ?? 0)}
          </s>
          <DiscountBadge priceAgorot={priceAgorot} compareAtPriceAgorot={compareAtPriceAgorot} />
        </>
      )}
    </>
  );
}
