'use client';

import { useCart } from '../lib/cart';
import { cartDrawer } from '../lib/cart-drawer-bus';

/**
 * The cart entry point, in two postures:
 *
 *   - `fab`    — the floating round button in `.sf-dock` (the pre-2026-09-13 behaviour).
 *   - `inline` — an icon button that sits in the commerce header and the mobile tab bar, with an
 *                optional visible text label.
 *
 * Both read the same `useCart` store so the count is one number wherever it is shown. Rendered on
 * the client only because the count lives in localStorage; the server renders zero items and the
 * badge appears after hydration, which is the same behaviour every large store has.
 */

export interface CartBadgeLabels {
  label: string;
  labelWithCount: string;
}

export interface CartBadgeProps {
  tenantId: string;
  labels: CartBadgeLabels;
  variant?: 'fab' | 'inline' | 'tab';
  /** `inline` only: show the label text beside the icon. */
  showLabel?: boolean;
}

export function CartBadge({ tenantId, labels, variant = 'fab', showLabel = false }: CartBadgeProps) {
  const { count } = useCart(tenantId);
  const accessibleLabel =
    count > 0 ? labels.labelWithCount.replace('{count}', String(count)) : labels.label;
  const shown = count > 99 ? '99+' : String(count);

  if (variant === 'tab') {
    return (
      <a
        className="sf-tabbar__item"
        href="/cart"
        aria-label={accessibleLabel}
        onClick={(event) => {
          event.preventDefault();
          cartDrawer('open');
        }}
      >
        <span className="sf-tabbar__icon">
          <CartIcon />
          {count > 0 ? (
            <span className="sf-count" aria-hidden="true">
              {shown}
            </span>
          ) : null}
        </span>
        <span className="sf-tabbar__label">{labels.label}</span>
      </a>
    );
  }

  if (variant === 'inline') {
    return (
      <a
        className="sf-iconbtn sf-iconbtn--cart"
        href="/cart"
        aria-label={accessibleLabel}
        onClick={(event) => {
          event.preventDefault();
          cartDrawer('open');
        }}
      >
        <span className="sf-iconbtn__icon">
          <CartIcon />
          {count > 0 ? (
            <span className="sf-count" aria-hidden="true">
              {shown}
            </span>
          ) : null}
        </span>
        {showLabel ? <span className="sf-iconbtn__label">{labels.label}</span> : null}
      </a>
    );
  }

  return (
    <a className="sf-cart-fab" href="/cart" aria-label={accessibleLabel}>
      <CartIcon />
      {count > 0 ? (
        <span className="sf-cart-fab__count" aria-hidden="true">
          {shown}
        </span>
      ) : null}
    </a>
  );
}

export function CartIcon() {
  return (
    <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false">
      <path
        fill="currentColor"
        d="M7 4h-2a1 1 0 0 0 0 2h1.2l2.24 9.4a2 2 0 0 0 1.95 1.6h7.22a2 2 0 0 0 1.94-1.51l1.4-5.6a1 1 0 0 0-.97-1.24H8.28l-.5-2.1A1 1 0 0 0 7 4Zm3.5 15.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Zm7 0a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Z"
      />
    </svg>
  );
}
