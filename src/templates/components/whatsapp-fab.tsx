import { st } from '../i18n';
import { buildOrderUrl, normaliseWhatsappNumber } from '../lib/whatsapp';
import type { StorefrontContext } from '../view-model';
import { WhatsappIcon } from './icons';

/**
 * The floating WhatsApp button — on EVERY page of the storefront, not only the contact block.
 *
 * WHY IT IS NOT ENOUGH THAT THE CONTACT SECTION HAS ONE. That button lives inside a section a
 * merchant can reorder or switch off, on ONE route (the home page), usually below the fold. A
 * customer on a product page, a category listing or a search result — which is where most of them
 * actually are when they decide to ask — had no way to open a conversation without scrolling back
 * to a section they may not have. WhatsApp is the entire order flow of the أساسي plan (Q5), so the
 * control that starts it belongs in the chrome, beside the cart, not in the content.
 *
 * NO JAVASCRIPT. A plain anchor with a pre-composed message, exactly like the ordering button in
 * `whatsapp-order.tsx` minus the quantity stepper — the only reason that one is a client component.
 * Nothing here is state, so nothing here needs a bundle on a Fast 3G budget.
 *
 * IT RENDERS NOTHING RATHER THAN SOMETHING BROKEN. Three conditions have to hold: the feature is
 * available to the tenant, a number is stored, and that number survives `normaliseWhatsappNumber` —
 * which refuses a local `059…` because Bartaa sits in the Seam Zone and the country code is
 * genuinely ambiguous (see `lib/whatsapp.ts`). A permanently-visible button that opens WhatsApp on
 * a number it cannot dial is worse than no button, and the contact section already prints the raw
 * number with an explanation for exactly that case.
 *
 * The label is `aria-label` + `title` rather than visible text: this is a 56px circle at the corner
 * of every page on a phone, and a pill wide enough for «اطلب عبر واتساب» would cover a product card.
 */
export function WhatsappFab({ context }: { context: StorefrontContext }) {
  if (!context.flags.whatsappOrders) return null;

  const number = normaliseWhatsappNumber(context.site.whatsapp);
  if (!number) return null;

  /**
   * A SHOP-level enquiry, like the contact section's — never the product template.
   *
   * This button is on every route, including product pages, and the product message takes
   * `{product}`/`{price}`/`{qty}`; feeding it a page it knows nothing about would send «بدي أطلب
   * … الكمية: {qty}» with the braces still in it. `order.messageShop` has nothing left to
   * substitute, which is what makes it safe to render from the shell.
   */
  const template = st('order.messageShop', { shop: context.site.name, url: context.origin });

  return (
    <a
      className="sf-wa-fab"
      href={buildOrderUrl({ number, template }, 1)}
      rel="noopener noreferrer"
      target="_blank"
      aria-label={st('order.whatsapp')}
      title={st('order.whatsapp')}
    >
      <WhatsappIcon className="sf-wa-fab__icon" aria-hidden="true" />
    </a>
  );
}
