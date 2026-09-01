import { translator } from '@/shared/i18n';

const ct = translator('catalogue');

/**
 * «تفاصيل القماش والعناية» — the block under the buy button.
 *
 * Separate from `description` on purpose, and the schema comment says why in one line: one sells
 * the product, the other stops a return. A shopper reading «قطن 100%، غسيل بارد على اليد» before
 * they order is a shopper who does not send the shirt back after washing it at sixty degrees, and
 * the merchant pays the delivery both ways.
 *
 * `<details>` for the same three reasons as `size-guide.tsx`: it opens on click and on enter, it
 * reports its expanded state to assistive technology, and it costs nothing to download. Closed by
 * default — this is reference material a shopper opens deliberately, and an open accordion pushes
 * the price and the buy control off a phone screen.
 */

export interface CareDetailsProps {
  /** Merchant-authored Arabic. Blank or whitespace renders nothing at all. */
  careInstructions: string | null | undefined;
}

export function CareDetails({ careInstructions }: CareDetailsProps) {
  const text = (careInstructions ?? '').trim();
  if (text === '') return null;

  /*
    Blank-line-separated paragraphs, matching how the product description is rendered on the same
    page. Merchants type care instructions as a short list with line breaks, and collapsing them
    into one paragraph turns four facts into a wall — but `dangerouslySetInnerHTML` is not on the
    table for merchant-authored text, so the split happens here and React escapes each part.
  */
  const paragraphs = text.split(/\n\s*\n|\n/).map((part) => part.trim()).filter((part) => part !== '');

  return (
    <details className="sf-note">
      <summary className="sf-link">{ct('care.open')}</summary>
      <div className="sf-prose">
        {paragraphs.map((paragraph, index) => (
          <p key={index}>{paragraph}</p>
        ))}
      </div>
    </details>
  );
}
