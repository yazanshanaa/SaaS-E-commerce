'use client';

import { useState } from 'react';

/**
 * The storefront order form (Phase 5).
 *
 * It renders ONLY when `context.flags.payments` is true — four server-side conjuncts, re-asked by
 * the route it posts to. Everywhere else the product page keeps the Q5 WhatsApp path exactly as
 * it was, with no field a visitor could type a name into.
 *
 * NO i18n IMPORT. Every string arrives already translated as a prop, for the same reason
 * `WhatsappOrder` takes a filled template: importing `@/shared/i18n` here would pull the whole
 * message catalogue into the storefront bundle, and the perf budget is LCP < 2.5s on Fast 3G.
 * The consequence is that this file contains no Arabic at all, which the language gate checks.
 *
 * `priceLabels` exists for the same reason: `formatAgorot` lives in the i18n module, so the server
 * pre-renders one label per quantity (99 short strings, about a kilobyte) rather than shipping a
 * formatter and a locale.
 *
 * The submit is a `fetch` rather than a server action because this is an UNAUTHENTICATED,
 * cross-surface POST: `/api/**` is unprefixed and answers on every hostname, and the route needs
 * its own Sec-Fetch-Site, Content-Type, rate-limit and entitlement ladder — the same one the push
 * subscribe endpoint carries, for the same reasons.
 */

export interface CheckoutLabels {
  heading: string;
  name: string;
  phone: string;
  note: string;
  quantity: string;
  increase: string;
  decrease: string;
  total: string;
  submit: string;
  submitting: string;
  privacy: string;
  instructionsTitle: string;
  successTitle: string;
  /** Carries `{number}` and nothing else. */
  successBody: string;
  errors: {
    name: string;
    phone: string;
    unavailable: string;
    closed: string;
    flooded: string;
    failed: string;
  };
}

export interface CheckoutFormProps {
  productSlug: string;
  /** Pre-formatted totals, keyed by quantity. Built on the server by `formatAgorot`. */
  priceLabels: Record<number, string>;
  maxQuantity: number;
  labels: CheckoutLabels;
  /** The merchant's own Arabic payment instructions, shown after the order lands. */
  instructions: string | null;
}

type Phase =
  | { kind: 'idle' }
  | { kind: 'sending' }
  | { kind: 'done'; number: number }
  | { kind: 'error'; message: string };

export function CheckoutForm({
  productSlug,
  priceLabels,
  maxQuantity,
  labels,
  instructions,
}: CheckoutFormProps) {
  const [quantity, setQuantity] = useState(1);
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });

  if (phase.kind === 'done') {
    return (
      <div className="sf-checkout sf-checkout--done" role="status">
        <h2 className="sf-checkout__title">{labels.successTitle}</h2>
        <p>{labels.successBody.replace('{number}', String(phase.number))}</p>
        {instructions ? (
          <>
            <h3 className="sf-checkout__title">{labels.instructionsTitle}</h3>
            <p className="sf-note">{instructions}</p>
          </>
        ) : null}
      </div>
    );
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);

    const customerName = String(form.get('customerName') ?? '').trim();
    const customerPhone = String(form.get('customerPhone') ?? '').trim();

    // A first pass in the browser, so the common mistake does not cost a round trip. It is NOT
    // the validation: the route zod-parses everything again and is the only thing that decides.
    if (customerName.length < 2) {
      setPhase({ kind: 'error', message: labels.errors.name });
      return;
    }
    if (!/^\+?[\d\s-]{9,20}$/.test(customerPhone)) {
      setPhase({ kind: 'error', message: labels.errors.phone });
      return;
    }

    setPhase({ kind: 'sending' });

    try {
      const response = await fetch('/api/storefront/checkout', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          productSlug,
          quantity,
          customerName,
          customerPhone,
          customerNote: String(form.get('customerNote') ?? '').trim() || undefined,
        }),
      });

      if (response.ok) {
        const body = (await response.json()) as { ok?: boolean; number?: number };
        if (body.ok && typeof body.number === 'number') {
          setPhase({ kind: 'done', number: body.number });
          return;
        }
      }

      /**
       * The route answers with a machine `reason` and never with Arabic — it is a server module,
       * and copy lives in the catalogue. The mapping is here, over strings this component was
       * handed. An unknown reason falls back to the generic failure rather than rendering a raw
       * identifier at a customer.
       */
      const body = (await response.json().catch(() => null)) as { reason?: string } | null;
      const message =
        body?.reason === 'unavailable'
          ? labels.errors.unavailable
          : body?.reason === 'flooded'
            ? labels.errors.flooded
            : response.status === 404
              ? labels.errors.closed
              : labels.errors.failed;

      setPhase({ kind: 'error', message });
    } catch {
      setPhase({ kind: 'error', message: labels.errors.failed });
    }
  }

  const sending = phase.kind === 'sending';

  return (
    /**
     * `method="post"` matters even though this form is only ever submitted by `onSubmit`.
     *
     * The page is server-rendered and `force-dynamic`, so between first paint and hydration the
     * markup is a real HTML form with a real submit button. A visitor who fills it in and presses
     * Enter in that window gets the HTML DEFAULT — and the default is GET to the current URL,
     * which would put their name and phone number in the query string, the browser history, the
     * server access log and any analytics that records paths. With `method="post"` the same
     * premature submit puts them in a request body that the product route does not accept, which
     * is a harmless failure instead of a durable one.
     */
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
        <input
          className="sf-input"
          id="checkout-name"
          name="customerName"
          type="text"
          autoComplete="name"
          required
          maxLength={120}
        />
      </div>

      <div className="sf-field">
        <label className="sf-label" htmlFor="checkout-phone">
          {labels.phone}
        </label>
        {/*
          `inputMode="tel"` rather than `type="number"`: a phone number is not a quantity, and a
          numeric input strips the leading `+` a Palestinian or Israeli number needs.
        */}
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

      <div className="sf-field">
        <label className="sf-label" htmlFor="checkout-note">
          {labels.note}
        </label>
        <textarea
          className="sf-textarea"
          id="checkout-note"
          name="customerNote"
          rows={2}
          maxLength={500}
        />
      </div>

      <div className="sf-stepper" role="group" aria-label={labels.quantity}>
        <button
          type="button"
          className="sf-stepper__btn"
          onClick={() => setQuantity((q) => Math.max(1, q - 1))}
          aria-label={labels.decrease}
          disabled={quantity <= 1 || sending}
        >
          −
        </button>
        <output className="sf-stepper__value" aria-live="polite">
          {quantity}
        </output>
        <button
          type="button"
          className="sf-stepper__btn"
          onClick={() => setQuantity((q) => Math.min(maxQuantity, q + 1))}
          aria-label={labels.increase}
          disabled={quantity >= maxQuantity || sending}
        >
          +
        </button>
      </div>

      <p className="sf-checkout__total">
        {labels.total}{' '}
        <output aria-live="polite">{priceLabels[quantity] ?? priceLabels[1]}</output>
      </p>

      {/*
        Stated where the collection happens, not buried in a policy page. This is the first
        customer PII this platform has ever held (Q5 held none), and the sentence names what is
        kept, who gets it, and when it goes.
      */}
      <p className="sf-note">{labels.privacy}</p>

      <button type="submit" className="sf-btn" disabled={sending}>
        {sending ? labels.submitting : labels.submit}
      </button>
    </form>
  );
}
