'use client';

import { useState } from 'react';
import { useCart } from '../lib/cart';

/**
 * Cart checkout (Phase 8, item 4): the Arabic form (name, phone, area, address, notes, payment
 * method), submitted to `/api/storefront/cart/checkout`, which recomputes everything server side
 * and is the only thing that decides. On success this shows the tracking code with a copyable
 * "تتبّع طلبك" link and a WhatsApp deep link carrying it (item 5), then clears the cart.
 *
 * NO i18n IMPORT — matching every other storefront client component.
 */

export interface CheckoutViewLabels {
  heading: string;
  name: string;
  phone: string;
  note: string;
  deliveryArea: string;
  deliveryAreaPlaceholder: string;
  deliveryAddress: string;
  paymentMethod: string;
  paymentMethods: Record<string, string>;
  submit: string;
  submitting: string;
  privacy: string;
  emptyCart: string;
  backToCart: string;
  successTitle: string;
  /** Carries `{number}`. */
  successBody: string;
  trackingLabel: string;
  trackingLink: string;
  copyLink: string;
  copied: string;
  whatsappShare: string;
  /** Carries `{number}` and `{trackingCode}`. */
  whatsappMessageTemplate: string;
  errors: CheckoutErrorLabels;
}

/**
 * Explicit keys resolve to a guaranteed `string` (not `string | undefined`) even under
 * `noUncheckedIndexedAccess`, while the index signature still types a DYNAMIC lookup (an
 * unrecognised `reason` from the route) as possibly missing — exactly the two cases this
 * component actually has.
 */
export interface CheckoutErrorLabels {
  name: string;
  phone: string;
  failed: string;
  closed: string;
  couponInvalid: string;
  [reason: string]: string;
}

export interface CheckoutViewProps {
  tenantId: string;
  whatsappNumber: string | null;
  paymentMethods: string[];
  deliveryAreas: string[];
  labels: CheckoutViewLabels;
}

type Phase =
  | { kind: 'form' }
  | { kind: 'sending' }
  | { kind: 'done'; number: number; trackingCode: string; totalAgorot: number }
  | { kind: 'error'; message: string };

export function CheckoutView({ tenantId, whatsappNumber, paymentMethods, deliveryAreas, labels }: CheckoutViewProps) {
  const cart = useCart(tenantId);
  const [phase, setPhase] = useState<Phase>({ kind: 'form' });
  const [copied, setCopied] = useState(false);

  // `cart.lines` is `[]` (the SSR snapshot) until `useCart` re-syncs after mount — see that
  // hook's own doc comment. No manual "hydrated" flag needed: the empty-cart branch below
  // renders correctly either way, and `phase.kind === 'done'` (which reads `window.location`)
  // is only reachable after a real client-side form submission.
  if (phase.kind === 'done') {
    const trackingUrl = `${window.location.origin}/order/${phase.trackingCode}`;
    const whatsappHref = whatsappNumber
      ? `https://wa.me/${whatsappNumber}?text=${encodeURIComponent(
          labels.whatsappMessageTemplate
            .replace('{number}', String(phase.number))
            .replace('{trackingCode}', phase.trackingCode),
        )}`
      : null;

    return (
      <div className="sf-checkout sf-checkout--done" role="status">
        <h2 className="sf-checkout__title">{labels.successTitle}</h2>
        <p>{labels.successBody.replace('{number}', String(phase.number))}</p>

        <p className="sf-note">
          {labels.trackingLabel}
          <br />
          <a className="sf-link" href={`/order/${phase.trackingCode}`}>
            {labels.trackingLink}
          </a>
        </p>

        <p className="sf-actions">
          <button
            type="button"
            className="sf-btn sf-btn--ghost"
            onClick={() => {
              navigator.clipboard?.writeText(trackingUrl).then(() => {
                setCopied(true);
                window.setTimeout(() => setCopied(false), 2_000);
              });
            }}
          >
            {copied ? labels.copied : labels.copyLink}
          </button>
          {whatsappHref ? (
            <a className="sf-btn" href={whatsappHref} rel="noopener noreferrer" target="_blank">
              {labels.whatsappShare}
            </a>
          ) : null}
        </p>
      </div>
    );
  }

  if (cart.lines.length === 0) {
    return (
      <div className="sf-checkout">
        <p className="sf-note">{labels.emptyCart}</p>
        <p className="sf-actions">
          <a className="sf-btn" href="/cart">
            {labels.backToCart}
          </a>
        </p>
      </div>
    );
  }

  async function submit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const form = new FormData(event.currentTarget);

    const customerName = String(form.get('customerName') ?? '').trim();
    const customerPhone = String(form.get('customerPhone') ?? '').trim();
    const paymentMethod = String(form.get('paymentMethod') ?? '');

    if (customerName.length < 2) {
      setPhase({ kind: 'error', message: labels.errors.name });
      return;
    }
    if (!/^\+?[\d\s-]{9,20}$/.test(customerPhone)) {
      setPhase({ kind: 'error', message: labels.errors.phone });
      return;
    }

    setPhase({ kind: 'sending' });

    // couponCode is read from sessionStorage so the choice made on the cart page survives the
    // navigation without round-tripping it through a hidden field an unrelated fork of this
    // page could forget to include.
    const couponCode = window.sessionStorage.getItem('sb-cart-coupon') || undefined;

    try {
      const response = await fetch('/api/storefront/cart/checkout', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          items: cart.lines,
          customerName,
          customerPhone,
          customerNote: String(form.get('customerNote') ?? '').trim() || undefined,
          deliveryArea: String(form.get('deliveryArea') ?? '').trim() || undefined,
          deliveryAddress: String(form.get('deliveryAddress') ?? '').trim() || undefined,
          paymentMethod,
          couponCode,
        }),
      });

      const body = (await response.json().catch(() => null)) as
        | { ok?: boolean; number?: number; trackingCode?: string; totalAgorot?: number; reason?: string }
        | null;

      if (response.ok && body?.ok && body.trackingCode && typeof body.number === 'number') {
        cart.clear();
        window.sessionStorage.removeItem('sb-cart-coupon');
        setPhase({ kind: 'done', number: body.number, trackingCode: body.trackingCode, totalAgorot: body.totalAgorot ?? 0 });
        return;
      }

      const reason = body?.reason ?? 'failed';
      const fallback = response.status === 404 ? labels.errors.closed : labels.errors.failed;
      const message =
        labels.errors[reason] ?? (reason.startsWith('coupon_') ? labels.errors.couponInvalid : fallback);

      setPhase({ kind: 'error', message });
    } catch {
      setPhase({ kind: 'error', message: labels.errors.failed });
    }
  }

  const sending = phase.kind === 'sending';

  return (
    <form className="sf-checkout" method="post" onSubmit={submit} noValidate>
      <h2 className="sf-checkout__title">{labels.heading}</h2>

      {phase.kind === 'error' ? (
        <p className="sf-checkout__error" role="alert">
          {phase.message}
        </p>
      ) : null}

      <div className="sf-field">
        <label className="sf-label" htmlFor="checkout-name">
          {labels.name}
        </label>
        <input className="sf-input" id="checkout-name" name="customerName" type="text" autoComplete="name" required maxLength={120} />
      </div>

      <div className="sf-field">
        <label className="sf-label" htmlFor="checkout-phone">
          {labels.phone}
        </label>
        <input
          className="sf-input"
          id="checkout-phone"
          name="customerPhone"
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          dir="ltr"
          required
          maxLength={20}
        />
      </div>

      {deliveryAreas.length > 0 ? (
        <div className="sf-field">
          <label className="sf-label" htmlFor="checkout-area">
            {labels.deliveryArea}
          </label>
          <select className="sf-select" id="checkout-area" name="deliveryArea">
            <option value="">{labels.deliveryAreaPlaceholder}</option>
            {deliveryAreas.map((area) => (
              <option key={area} value={area}>
                {area}
              </option>
            ))}
          </select>
        </div>
      ) : null}

      <div className="sf-field">
        <label className="sf-label" htmlFor="checkout-address">
          {labels.deliveryAddress}
        </label>
        <input className="sf-input" id="checkout-address" name="deliveryAddress" type="text" maxLength={500} />
      </div>

      <div className="sf-field">
        <label className="sf-label" htmlFor="checkout-note">
          {labels.note}
        </label>
        <textarea className="sf-textarea" id="checkout-note" name="customerNote" rows={2} maxLength={500} />
      </div>

      <fieldset className="sf-field">
        <legend className="sf-label">{labels.paymentMethod}</legend>
        {paymentMethods.map((method, index) => (
          <label className="sf-check" key={method} htmlFor={`payment-${method}`}>
            <input
              id={`payment-${method}`}
              type="radio"
              name="paymentMethod"
              value={method}
              defaultChecked={index === 0}
              required
            />
            <span>{labels.paymentMethods[method] ?? method}</span>
          </label>
        ))}
      </fieldset>

      <p className="sf-note">{labels.privacy}</p>

      <button type="submit" className="sf-btn" disabled={sending}>
        {sending ? labels.submitting : labels.submit}
      </button>
    </form>
  );
}
