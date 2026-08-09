'use client';

import { useState } from 'react';
import { buildOrderUrl } from '../lib/whatsapp';
import { WhatsappIcon } from './icons';

/**
 * WhatsApp ordering (Q5) — the entire order flow of the V1 storefront.
 *
 * The message is composed HERE, in the visitor's browser, and handed to their own WhatsApp. No
 * request reaches this platform, no `Order` row is written, and the visitor is never asked for
 * a name, a phone number or an address. The storefront collects no customer PII at all, which
 * is precisely why Phase 6's privacy copy is short and true.
 *
 * The quantity stepper is the only reason this is a client component rather than a plain link:
 * the message template arrives already translated and already filled with the shop name, the
 * product, the price and the URL, and the only thing left to substitute is `{qty}`.
 */

export interface WhatsappOrderProps {
  number: string;
  /** Arabic, translated on the server, containing `{qty}` and nothing else unresolved. */
  messageTemplate: string;
  labels: {
    order: string;
    quantity: string;
    increase: string;
    decrease: string;
    hint: string;
  };
  /** The stepper is hidden on a product card and shown on the product page. */
  showQuantity?: boolean;
  disabled?: boolean;
}

const MAX_QUANTITY = 99;

export function WhatsappOrder({
  number,
  messageTemplate,
  labels,
  showQuantity = false,
  disabled = false,
}: WhatsappOrderProps) {
  const [quantity, setQuantity] = useState(1);
  const href = buildOrderUrl({ number, template: messageTemplate }, quantity);

  return (
    <div className="sf-order">
      {showQuantity ? (
        <div className="sf-stepper" role="group" aria-label={labels.quantity}>
          <button
            type="button"
            className="sf-stepper__btn"
            onClick={() => setQuantity((q) => Math.max(1, q - 1))}
            aria-label={labels.decrease}
            disabled={quantity <= 1}
          >
            −
          </button>
          {/*
            A live region rather than a number input: an input invites a keyboard on a phone for
            a value that is almost always 1, 2 or 3, and it would need its own validation.
          */}
          <output className="sf-stepper__value" aria-live="polite">
            {quantity}
          </output>
          <button
            type="button"
            className="sf-stepper__btn"
            onClick={() => setQuantity((q) => Math.min(MAX_QUANTITY, q + 1))}
            aria-label={labels.increase}
            disabled={quantity >= MAX_QUANTITY}
          >
            +
          </button>
        </div>
      ) : null}

      <a
        className="sf-btn"
        href={disabled ? undefined : href}
        rel="noopener noreferrer"
        target="_blank"
        aria-disabled={disabled || undefined}
      >
        <WhatsappIcon className="sf-btn__icon" />
        {labels.order}
      </a>

      {showQuantity ? <p className="sf-order__hint">{labels.hint}</p> : null}
    </div>
  );
}
