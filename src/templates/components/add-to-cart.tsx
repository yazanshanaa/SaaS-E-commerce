'use client';

import { useState } from 'react';
import { useCart } from '../lib/cart';

/**
 * "أضف للسلة" (Phase 8, item 2) — on the product card AND the product page, replacing
 * `WhatsappOrder` wherever `flags.cart` is true (never rendered alongside it — see the product
 * page and product card for the branch).
 *
 * NO i18n IMPORT, matching `WhatsappOrder` and `CheckoutForm` exactly and for the same reason:
 * every string arrives pre-translated as a prop, so this file does not pull the message
 * catalogue into the storefront bundle.
 */

export interface AddToCartLabels {
  add: string;
  added: string;
  quantity: string;
  increase: string;
  decrease: string;
  viewCart: string;
  outOfStock: string;
}

export interface AddToCartProps {
  tenantId: string;
  productSlug: string;
  labels: AddToCartLabels;
  /** Shown on the product page (with a stepper); hidden on the card (quantity 1, adjusted later
   *  on the cart page) — the same split `WhatsappOrder` already draws. */
  showQuantity?: boolean;
  disabled?: boolean;
  maxQuantity?: number;
}

const DEFAULT_MAX_QUANTITY = 99;
const CONFIRMATION_MS = 2_000;

export function AddToCart({
  tenantId,
  productSlug,
  labels,
  showQuantity = false,
  disabled = false,
  maxQuantity = DEFAULT_MAX_QUANTITY,
}: AddToCartProps) {
  const cart = useCart(tenantId);
  const [quantity, setQuantity] = useState(1);
  const [justAdded, setJustAdded] = useState(false);

  function handleAdd(event: React.MouseEvent<HTMLButtonElement>): void {
    // The card wraps the whole surface in an anchor (product-card.tsx); this button is a
    // sibling of it, not a descendant, but stopping propagation here costs nothing and removes
    // any doubt about it if that ever changes.
    event.preventDefault();
    event.stopPropagation();

    cart.add(productSlug, quantity);
    setJustAdded(true);
    window.setTimeout(() => setJustAdded(false), CONFIRMATION_MS);
  }

  if (disabled) {
    return <p className="sf-badge sf-badge--off">{labels.outOfStock}</p>;
  }

  return (
    <div className="sf-order">
      {showQuantity ? (
        <div className="sf-stepper" role="group" aria-label={labels.quantity}>
          <button
            type="button"
            className="sf-stepper__btn"
            onClick={(event) => {
              event.preventDefault();
              setQuantity((q) => Math.max(1, q - 1));
            }}
            aria-label={labels.decrease}
            disabled={quantity <= 1}
          >
            −
          </button>
          <output className="sf-stepper__value" aria-live="polite">
            {quantity}
          </output>
          <button
            type="button"
            className="sf-stepper__btn"
            onClick={(event) => {
              event.preventDefault();
              setQuantity((q) => Math.min(maxQuantity, q + 1));
            }}
            aria-label={labels.increase}
            disabled={quantity >= maxQuantity}
          >
            +
          </button>
        </div>
      ) : null}

      <button type="button" className="sf-btn" onClick={handleAdd} aria-live="polite">
        {justAdded ? labels.added : labels.add}
      </button>

      {justAdded ? (
        <a className="sf-link" href="/cart">
          {labels.viewCart}
        </a>
      ) : null}
    </div>
  );
}
