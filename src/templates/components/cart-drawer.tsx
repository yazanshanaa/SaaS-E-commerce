'use client';

import { useEffect, useRef, useState } from 'react';
import { useCart } from '../lib/cart';
import { CART_DRAWER_EVENT, cartDrawer, type CartDrawerCommand } from '../lib/cart-drawer-bus';
import { CartIcon } from './cart-badge';

/**
 * The cart drawer — the side panel every Shopify and Salla store opens on «أضف للسلة».
 *
 * A `<dialog>` element, so focus trapping, Escape, and the backdrop come from the browser rather
 * than from a library (the storefront ships no UI library, by contract). Opens on the
 * `sf:cart-drawer` window event (see lib/cart-drawer-bus.ts); the header button, the phone tab and
 * `AddToCart` all dispatch it.
 *
 * Prices come from the same `/api/storefront/cart/quote` endpoint the cart page uses — the drawer
 * never trusts a price stored in the browser. Coupons, delivery and minimum order stay on the full
 * cart page: the drawer answers "what did I add and what does it cost", one tap from anywhere.
 *
 * Labels arrive resolved: this is a client component and must not import the message catalogue.
 */

export interface CartDrawerLabels {
  title: string;
  empty: string;
  continueShopping: string;
  subtotal: string;
  viewCart: string;
  checkout: string;
  remove: string;
  increase: string;
  decrease: string;
  quantity: string;
  close: string;
  unavailable: string;
  loading: string;
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
  currency: string | null;
}

function formatMoney(agorot: number, currency: string | null): string {
  const shekels = (agorot / 100).toFixed(2).replace(/\.00$/, '');
  return currency === 'ILS' || !currency ? `${shekels} ₪` : `${shekels} ${currency}`;
}

export function CartDrawer({ tenantId, labels }: { tenantId: string; labels: CartDrawerLabels }) {
  const cart = useCart(tenantId);
  const dialog = useRef<HTMLDialogElement | null>(null);
  const [open, setOpen] = useState(false);
  const [quote, setQuote] = useState<QuoteResponse | null>(null);
  const [loading, setLoading] = useState(false);

  // The bus → the dialog element. `showModal` is what gives us the backdrop and the focus trap.
  useEffect(() => {
    function onCommand(event: Event): void {
      const command = (event as CustomEvent<CartDrawerCommand>).detail;
      setOpen((current) => (command === 'toggle' ? !current : command === 'open'));
    }
    window.addEventListener(CART_DRAWER_EVENT, onCommand);
    return () => window.removeEventListener(CART_DRAWER_EVENT, onCommand);
  }, []);

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) element.showModal();
    if (!open && element.open) element.close();
  }, [open]);

  // Re-quote whenever the drawer is open and the lines change. An empty cart simply renders the
  // empty state below without asking the server anything; the stale quote is ignored, not cleared.
  useEffect(() => {
    if (!open || cart.lines.length === 0) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => setLoading(true), 0);
    fetch('/api/storefront/cart/quote', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ items: cart.lines }),
      signal: controller.signal,
    })
      .then(async (response) =>
        response.ok
          ? ((await response.json()) as { ok?: boolean; quote?: QuoteResponse } | null)
          : null,
      )
      .then((body) => {
        // The endpoint answers `{ ok, quote }` — the same envelope the cart page reads.
        if (body?.ok && body.quote && Array.isArray(body.quote.items)) setQuote(body.quote);
      })
      .catch(() => undefined)
      .finally(() => setLoading(false));
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [open, cart.lines]);

  const close = () => setOpen(false);

  return (
    <dialog
      ref={dialog}
      className="sf-drawer"
      aria-label={labels.title}
      onClose={close}
      onClick={(event) => {
        // A click on the backdrop (the dialog element itself, outside the panel) closes it.
        if (event.target === dialog.current) close();
      }}
    >
      <div className="sf-drawer__panel">
        <header className="sf-drawer__head">
          <h2 className="sf-drawer__title">
            <CartIcon />
            {labels.title}
            {cart.count > 0 ? <span className="sf-drawer__count">{cart.count}</span> : null}
          </h2>
          <button type="button" className="sf-drawer__close" onClick={close} aria-label={labels.close}>
            ×
          </button>
        </header>

        {cart.lines.length === 0 ? (
          <div className="sf-drawer__empty">
            <p>{labels.empty}</p>
            <button type="button" className="sf-btn" onClick={close}>
              {labels.continueShopping}
            </button>
          </div>
        ) : (
          <>
            <ul className="sf-drawer__lines" aria-busy={loading}>
              {cart.lines.map((line) => {
                const quoted = quote?.items.find((item) => item.productSlug === line.productSlug);
                return (
                  <li className="sf-drawer__line" key={line.productSlug}>
                    <div className="sf-drawer__line-main">
                      <a className="sf-drawer__name" href={`/products/${line.productSlug}`}>
                        {quoted?.nameSnapshot ?? line.productSlug}
                      </a>
                      <span className="sf-drawer__price">
                        {quoted
                          ? quoted.available && quoted.priceAgorot !== null
                            ? formatMoney(quoted.subtotalAgorot, quote?.currency ?? null)
                            : labels.unavailable
                          : loading
                            ? labels.loading
                            : ''}
                      </span>
                    </div>
                    <div className="sf-drawer__line-tools">
                      <div className="sf-stepper" role="group" aria-label={labels.quantity}>
                        <button
                          type="button"
                          className="sf-stepper__btn"
                          aria-label={labels.decrease}
                          disabled={line.quantity <= 1}
                          onClick={() => cart.setQuantity(line.productSlug, line.quantity - 1)}
                        >
                          −
                        </button>
                        <output className="sf-stepper__value">{line.quantity}</output>
                        <button
                          type="button"
                          className="sf-stepper__btn"
                          aria-label={labels.increase}
                          onClick={() => cart.setQuantity(line.productSlug, line.quantity + 1)}
                        >
                          +
                        </button>
                      </div>
                      <button
                        type="button"
                        className="sf-link sf-drawer__remove"
                        onClick={() => cart.remove(line.productSlug)}
                      >
                        {labels.remove}
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>

            <footer className="sf-drawer__foot">
              <div className="sf-drawer__subtotal">
                <span>{labels.subtotal}</span>
                <strong>{quote ? formatMoney(quote.subtotalAgorot, quote.currency) : '…'}</strong>
              </div>
              <a className="sf-btn sf-btn--full" href="/checkout">
                {labels.checkout}
              </a>
              <a className="sf-btn sf-btn--ghost sf-btn--full" href="/cart">
                {labels.viewCart}
              </a>
            </footer>
          </>
        )}
      </div>
    </dialog>
  );
}

/** The header / tab-bar cart control: opens the drawer, falls back to `/cart` without JS. */
export function CartOpener({
  className,
  ariaLabel,
  children,
}: {
  className: string;
  ariaLabel: string;
  children: React.ReactNode;
}) {
  return (
    <a
      className={className}
      href="/cart"
      aria-label={ariaLabel}
      onClick={(event) => {
        event.preventDefault();
        cartDrawer('open');
      }}
    >
      {children}
    </a>
  );
}
