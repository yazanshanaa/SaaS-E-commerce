/**
 * WhatsApp ordering (Q5).
 *
 * The V1 storefront collects NO customer PII: no name, no phone, no address, and no order row
 * anywhere. The visitor presses a button, their own WhatsApp opens with an Arabic message
 * already written, and the conversation lives in the merchant's phone from that moment on.
 * That is the entire mechanism, and it is why this platform's privacy story is cheap to keep
 * true — see docs/PHASES.md Q5 before "improving" it with a name field.
 *
 * Pure functions with no i18n import on purpose: the message TEMPLATE is translated on the
 * server and handed down, so a client component never pulls the whole message catalogue into
 * the storefront bundle.
 */

/**
 * `+972 50-000-0000` -> `972500000000`.
 *
 * Returns null for anything that is not in international form. Deliberately no guessing: a
 * local `059…` could be Palestinian or Israeli depending on which side of the Seam Zone the
 * merchant sits, and a wrong country code sends a customer's order to a stranger. The dashboard
 * already demands international format (`validation.whatsapp`), so the honest answer to a bad
 * number is to show the phone number instead of a broken button.
 */
export function normaliseWhatsappNumber(raw: string | null | undefined): string | null {
  if (!raw) return null;

  const trimmed = raw.trim();
  const digits = trimmed.replace(/\D/g, '');
  if (!digits) return null;

  const international = trimmed.startsWith('+')
    ? digits
    : digits.startsWith('00')
      ? digits.slice(2)
      : digits;

  // A leading zero after the country prefix has been removed means we were given a LOCAL
  // number and cannot tell which country it belongs to.
  if (international.startsWith('0')) return null;
  if (international.length < 8 || international.length > 15) return null;

  return international;
}

export interface OrderMessageParts {
  /** Already-Arabic template carrying `{qty}` and nothing else left to fill. */
  template: string;
  number: string;
}

export function fillOrderMessage(template: string, quantity: number): string {
  const safe = Number.isFinite(quantity) && quantity > 0 ? Math.floor(quantity) : 1;
  return template.replace(/\{qty\}/g, String(safe));
}

/** `https://wa.me/972500000000?text=…` — opened by the visitor's own client, never by us. */
export function whatsappUrl(number: string, message: string): string {
  return `https://wa.me/${number}?text=${encodeURIComponent(message)}`;
}

export function buildOrderUrl(parts: OrderMessageParts, quantity: number): string {
  return whatsappUrl(parts.number, fillOrderMessage(parts.template, quantity));
}
