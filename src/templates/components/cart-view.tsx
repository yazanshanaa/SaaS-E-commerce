'use client';

import { useEffect, useState } from 'react';
import { useCart } from '../lib/cart';

/**
 * The cart page (Phase 8, item 2): line items, a coupon field, the delivery fee and the total —
 * every number on this screen comes from `/api/storefront/cart/quote`, never computed client
 * side, because "all prices and totals recomputed server-side at checkout — never trust the
 * client" (the change plan's own words) has to already be true here, before checkout, or the
 * number a customer commits to would differ from the one they were shown.
 *
 * NO i18n IMPORT — labels arrive pre-translated, matching every other storefront client
 * component.
 */

export interface CartViewLabels {
  title: string;
  empty: string;
  continueShopping: string;
  quantity: string;
  increase: string;
  decrease: string;
  remove: string;
  subtotal: string;
  discount: string;
  deliveryFee: string;
  total: string;
  freeDelivery: string;
  couponLabel: string;
  couponPlaceholder: string;
  couponApply: string;
  couponRemove: string;
  couponApplied: string;
  checkout: string;
  unavailable: string;
  minOrder: string;
  loading: string;
  /** Carries `{number}`. */
  minOrderMessage: string;
  couponErrors: Record<string, string>;
}

interface QuoteLine {
  productSlug: string;
  found: boolean;
  available: boolean;
  nameSnapshot: string | null;
  priceAgorot: number | null;
  quantity: number;
  subtotalAgorot: number;
}

interface QuoteResponse {
  items: QuoteLine[];
  subtotalAgorot: number;
  discountAgorot: number;
  deliveryFeeAgorot: number;
  totalAgorot: number;
  currency: string | null;
  couponValid: boolean;
  couponError: string | null;
  minOrderAmountAgorot: number;
  belowMinOrder: boolean;
  paymentMethods: string[];
  deliveryAreas: string[];
  orderingPaused: boolean;
}

function formatMoney(agorot: number, currency: string | null): string {
  // A tiny, dependency-free formatter — the full `formatAgorot` lives in the i18n layer this
  // file deliberately does not import (see the file's own doc comment).
  const shekels = (agorot / 100).toFixed(2);
  return currency === 'ILS' || !currency ? `${shekels} ₪` : `${shekels} ${currency}`;
}

/** Reads outside React (a lazy `useState` initializer, not an effect) — safe because it only
 *  ever runs in the browser: the initializer for a `'use client'` component's `useState` runs
 *  during render, but `sessionStorage` is guarded for the one render that still happens on the
 *  server (Next's SSR pass through this component tree). */
function storedCoupon(): string {
  if (typeof window === 'undefined') return '';
  return window.sessionStorage.getItem('sb-cart-coupon') ?? '';
}

export function CartView({ tenantId, labels }: { tenantId: string; labels: CartViewLabels }) {
  const cart = useCart(tenantId);
  const [quote, setQuote] = useState<QuoteResponse | null>(null);
  const [couponCode, setCouponCode] = useState(storedCoupon);
  const [appliedCoupon, setAppliedCoupon] = useState(storedCoupon);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    // Nothing to quote — and nothing reads `quote` on the empty-cart render path below, so this
    // just skips the fetch rather than resetting state the render never looks at.
    if (cart.lines.length === 0) return;

    let cancelled = false;

    // The whole body runs inside an async IIFE — matching `push-toggle.tsx`'s own pattern —
    // rather than calling `setLoading`/`setQuote` as direct statements in the effect: React's
    // `set-state-in-effect` rule is about a synchronous setState triggering a SECOND render
    // before paint, and a `.then()`/`await` continuation is never that.
    void (async () => {
      setLoading(true);
      try {
        const response = await fetch('/api/storefront/cart/quote', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ items: cart.lines, couponCode: appliedCoupon || undefined }),
        });
        const body = response.ok
          ? ((await response.json()) as { ok?: boolean; quote?: QuoteResponse })
          : null;
        if (!cancelled && body?.ok && body.quote) setQuote(body.quote);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
    // `cart.lines` is safe as a dependency despite being a fresh value from a hook: `useCart`'s
    // snapshot cache (src/templates/lib/cart.ts) returns a REFERENCE-STABLE array whenever the
    // content has not actually changed, so this effect re-fires exactly on real cart changes.
  }, [tenantId, cart.lines, appliedCoupon]);

  if (cart.lines.length === 0) {
    return (
      <div className="sf-cart">
        <h1 className="sf-block__title">{labels.title}</h1>
        <p className="sf-note">{labels.empty}</p>
        <p className="sf-actions">
          <a className="sf-btn" href="/products">
            {labels.continueShopping}
          </a>
        </p>
      </div>
    );
  }

  return (
    <div className="sf-cart">
      <h1 className="sf-block__title">{labels.title}</h1>

      <ul className="sf-cart__lines">
        {(quote?.items ?? cart.lines.map((line) => ({ ...line, found: true, available: true, nameSnapshot: null, priceAgorot: null, subtotalAgorot: 0 }))).map((item) => (
          <li className="sf-cart__line" key={item.productSlug}>
            <div className="sf-cart__line-name">
              {item.nameSnapshot ?? item.productSlug}
              {!item.found || !item.available ? (
                <span className="sf-badge sf-badge--off">{labels.unavailable}</span>
              ) : null}
            </div>

            <div className="sf-stepper" role="group" aria-label={labels.quantity}>
              <button
                type="button"
                className="sf-stepper__btn"
                onClick={() => cart.setQuantity(item.productSlug, item.quantity - 1)}
                aria-label={labels.decrease}
              >
                −
              </button>
              <output className="sf-stepper__value" aria-live="polite">
                {item.quantity}
              </output>
              <button
                type="button"
                className="sf-stepper__btn"
                onClick={() => cart.setQuantity(item.productSlug, item.quantity + 1)}
                aria-label={labels.increase}
              >
                +
              </button>
            </div>

            <span className="sf-price">
              {item.priceAgorot !== null ? formatMoney(item.subtotalAgorot, quote?.currency ?? null) : '—'}
            </span>

            <button
              type="button"
              className="sf-btn sf-btn--quiet"
              onClick={() => cart.remove(item.productSlug)}
            >
              {labels.remove}
            </button>
          </li>
        ))}
      </ul>

      <div className="sf-cart__coupon">
        <label className="sf-label" htmlFor="cart-coupon">
          {labels.couponLabel}
        </label>
        <div className="sf-actions">
          <input
            id="cart-coupon"
            className="sf-input"
            dir="ltr"
            placeholder={labels.couponPlaceholder}
            value={couponCode}
            onChange={(event) => setCouponCode(event.target.value)}
            maxLength={40}
          />
          {appliedCoupon ? (
            <button
              type="button"
              className="sf-btn sf-btn--ghost"
              onClick={() => {
                setAppliedCoupon('');
                setCouponCode('');
                window.sessionStorage.removeItem('sb-cart-coupon');
              }}
            >
              {labels.couponRemove}
            </button>
          ) : (
            <button
              type="button"
              className="sf-btn sf-btn--ghost"
              onClick={() => {
                const code = couponCode.trim();
                setAppliedCoupon(code);
                // Read back at checkout (checkout-view.tsx) — sessionStorage rather than a query
                // string or a hidden field threaded through a page navigation the two components
                // do not otherwise share state across.
                window.sessionStorage.setItem('sb-cart-coupon', code);
              }}
              disabled={!couponCode.trim()}
            >
              {labels.couponApply}
            </button>
          )}
        </div>
        {appliedCoupon && quote ? (
          quote.couponValid ? (
            <p className="sf-note">{labels.couponApplied}</p>
          ) : quote.couponError ? (
            <p className="sf-checkout__error" role="alert">
              {labels.couponErrors[quote.couponError] ?? labels.couponErrors.invalid}
            </p>
          ) : null
        ) : null}
      </div>

      {quote ? (
        <dl className="sf-cart__totals">
          <div>
            <dt>{labels.subtotal}</dt>
            <dd>{formatMoney(quote.subtotalAgorot, quote.currency)}</dd>
          </div>
          {quote.discountAgorot > 0 ? (
            <div>
              <dt>{labels.discount}</dt>
              <dd>−{formatMoney(quote.discountAgorot, quote.currency)}</dd>
            </div>
          ) : null}
          <div>
            <dt>{labels.deliveryFee}</dt>
            <dd>{quote.deliveryFeeAgorot === 0 ? labels.freeDelivery : formatMoney(quote.deliveryFeeAgorot, quote.currency)}</dd>
          </div>
          <div className="sf-cart__totals-grand">
            <dt>{labels.total}</dt>
            <dd className="sf-price">{formatMoney(quote.totalAgorot, quote.currency)}</dd>
          </div>
        </dl>
      ) : null}

      {quote?.belowMinOrder ? (
        <p className="sf-checkout__error" role="alert">
          {labels.minOrderMessage.replace('{number}', formatMoney(quote.minOrderAmountAgorot, quote.currency))}
        </p>
      ) : null}

      <p className="sf-actions">
        <a
          className="sf-btn"
          href="/checkout"
          aria-disabled={loading || quote?.belowMinOrder || quote?.orderingPaused ? 'true' : undefined}
          onClick={(event) => {
            if (loading || quote?.belowMinOrder || quote?.orderingPaused) event.preventDefault();
          }}
        >
          {loading ? labels.loading : labels.checkout}
        </a>
      </p>
    </div>
  );
}
