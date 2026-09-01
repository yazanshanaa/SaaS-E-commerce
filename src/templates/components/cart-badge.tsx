'use client';

import { useCart } from '../lib/cart';

/**
 * The floating cart button (Phase 8, item 2) — present on every page of the storefront while
 * `flags.cart` is true, rendered once from `StorefrontShell` so no page has to remember it.
 *
 * Renders even at count 0 (as a plain link to an empty cart) rather than disappearing: a
 * vanishing button that reappears the moment something is added is a worse affordance than one
 * that is always exactly where a customer expects it, matching the "أضف للسلة" confirmation link
 * (`add-to-cart.tsx`) which points at the same place.
 */

export interface CartBadgeLabels {
  /** Used at count 0. */
  label: string;
  /** Carries `{count}` — used once there is at least one item, so a screen reader announces the
   *  quantity as part of the link's own accessible name, not only as a visual badge. */
  labelWithCount: string;
}

export function CartBadge({ tenantId, labels }: { tenantId: string; labels: CartBadgeLabels }) {
  const { count } = useCart(tenantId);
  const accessibleLabel = count > 0 ? labels.labelWithCount.replace('{count}', String(count)) : labels.label;

  return (
    <a className="sf-cart-fab" href="/cart" aria-label={accessibleLabel}>
      <CartIcon />
      {count > 0 ? (
        <span className="sf-cart-fab__count" aria-hidden="true">
          {count > 99 ? '99+' : count}
        </span>
      ) : null}
    </a>
  );
}

function CartIcon() {
  return (
    <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false">
      <path
        fill="currentColor"
        d="M7 4h-2a1 1 0 0 0 0 2h1.2l2.24 9.4a2 2 0 0 0 1.95 1.6h7.22a2 2 0 0 0 1.94-1.51l1.4-5.6a1 1 0 0 0-.97-1.24H8.28l-.5-2.1A1 1 0 0 0 7 4Zm3.5 15.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Zm7 0a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Z"
      />
    </svg>
  );
}
