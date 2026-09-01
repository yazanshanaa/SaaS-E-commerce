import { formatAgorot, formatNumber, translator } from '@/shared/i18n';

const ct = translator('catalogue');

/**
 * The size / colour picker.
 *
 * NO JAVASCRIPT, and that is not a limitation being made a virtue: a radio group is the native
 * control for "choose exactly one of these", it arrives with keyboard support, roving focus and a
 * group label for free, and it submits with the form it sits in. A scripted swatch grid would
 * have to re-implement all four and would stop working on the Fast 3G connection this
 * storefront's LCP budget is written for.
 *
 * ONE control for the whole combination rather than one per axis. Two dependent selects (size,
 * then colour) look tidier and are wrong: the sellable set is sparse — a shop stocks M in pink
 * and L in black and nothing else — so independent axes offer combinations that do not exist,
 * and making the second depend on the first needs the script this component refuses to load. One
 * radio per real row can only ever offer what the merchant actually has.
 *
 * Rows the merchant switched off never arrive here (`sellableVariants`). Rows that are merely OUT
 * OF STOCK do arrive, disabled, because a shopper who cannot find the size they wanted assumes
 * the shop never had it; «M · وردي — خلص المخزون» tells them to come back.
 */

export interface VariantChoice {
  id: string;
  /** «M · وردي», assembled server-side by `variantLabel` so every surface says it identically. */
  label: string;
  /** Already resolved: the variant's own override, or the product's price. */
  priceAgorot: number;
  /** False only when the policy actually blocks selling at zero. */
  inStock: boolean;
  /**
   * The remaining count, or null when it must not be shown — an untracked product, or a
   * `track_and_allow` backorder where the number is meaningless (and possibly negative).
   */
  remaining: number | null;
}

export interface VariantPickerProps {
  choices: VariantChoice[];
  /** The product's own price. A choice matching it prints no price of its own. */
  productPriceAgorot: number;
  /**
   * The form field name. Defaults to `variantId`, which is what the checkout and cart routes
   * expect once they accept a variant (see docs/PHASE-9-track-a-handoff.md).
   */
  name?: string;
}

export function VariantPicker({
  choices,
  productPriceAgorot,
  name = 'variantId',
}: VariantPickerProps) {
  if (choices.length === 0) return null;

  // The first IN-STOCK row is pre-selected, not simply the first row: defaulting to a sold-out
  // size means the customer's first click is to fix a choice they never made.
  const firstAvailable = choices.find((choice) => choice.inStock);

  return (
    <fieldset className="sf-field">
      <legend className="sf-label">{ct('variants.title')}</legend>

      <div className="sf-chips">
        {choices.map((choice) => {
          const id = `${name}-${choice.id}`;
          const differs = choice.priceAgorot !== productPriceAgorot;

          return (
            <label className="sf-check" htmlFor={id} key={choice.id}>
              <input
                id={id}
                type="radio"
                name={name}
                value={choice.id}
                defaultChecked={choice.id === firstAvailable?.id}
                /*
                  `disabled`, not `aria-disabled`. A disabled radio is skipped by the arrow-key
                  walk of the group, which is the behaviour wanted here — the row is there to be
                  READ, not chosen — and it also cannot be submitted, so a customer with a stale
                  page cannot order it by pressing enter.
                */
                disabled={!choice.inStock}
              />
              <span>
                {choice.label}
                {differs ? (
                  <span className="sf-price">{formatAgorot(choice.priceAgorot)}</span>
                ) : null}
                {choice.inStock ? (
                  choice.remaining === null ? null : (
                    /* `.sf-badge`, not `.sf-note`: the note class is a bordered card with large
                       padding, and one of those inside a radio label would be a box the size of the
                       control it annotates. The badge is the storefront's inline pill and is what
                       the out-of-stock marker below already uses. */
                    <span className="sf-badge">
                      {ct('stock.left', { count: formatNumber(choice.remaining) })}
                    </span>
                  )
                ) : (
                  <span className="sf-badge sf-badge--off">{ct('stock.outOfStock')}</span>
                )}
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
