import type { SectionConfig } from '@/shared/site-contract';
import { isolateRanges } from '../lib/ltr-ranges';
import { ClockIcon, MapPinIcon, NavigationIcon, PhoneIcon } from '../components/icons';
import { WhatsappOrder } from '../components/whatsapp-order';
import { st } from '../i18n';
import { resolveHoursLine } from '../lib/hours-summary';
import { resolveMapTarget } from '../lib/map-links';
import { normaliseWhatsappNumber } from '../lib/whatsapp';
import { SECTION_ANCHORS } from '../section-anchors';
import type { StorefrontContext } from '../view-model';
import { SectionBlock } from './block';

/**
 * The contact block: the shop's details, the WhatsApp button, and the social links.
 *
 * `config.buttonLabel` may override the label but NOT the number — the number always comes from
 * `Site.whatsapp`. A section config that could carry its own phone number would be a section
 * config that can silently send a merchant's customers to the wrong phone, and the section
 * schema in `site-contract` deliberately has no field for it.
 *
 * When the stored number is not in international form the button is replaced by the phone
 * number and a plain sentence. See `lib/whatsapp.ts` for why guessing a country code is refused.
 */

export interface ContactSectionProps {
  context: StorefrontContext;
  config: SectionConfig<'contact_whatsapp'>;
  /** Unique-per-page override from `SectionList`; falls back to the type's stable anchor. */
  anchor?: string;
}

export function ContactWhatsappSection({ context, config, anchor }: ContactSectionProps) {
  const { site } = context;
  const number = normaliseWhatsappNumber(site.whatsapp);

  /**
   * The STRUCTURED week first, the free-text box only as a fallback (2026-09-06, owner-directed).
   *
   * `Site.hours` is a textarea on `/settings`; the day-and-time picker on `/content/hours` writes
   * `OpeningHours` rows. Only the textarea ever reached this block, so a merchant who filled in the
   * picker — the control the platform actually asks them to use — saw their old typed sentence here
   * regardless. `resolveHoursLine` ranks the two and returns null when neither is filled, which is
   * what keeps the row from rendering an empty «أوقات الدوام». See `lib/hours-summary.ts`.
   */
  const hoursLine = resolveHoursLine(context.openingHours, site.hours);

  /**
   * THE LOCATION LIVES HERE NOW (2026-09-09) — the same resolver «موقعنا» uses, on the block that
   * already prints the address.
   *
   * The default arrangement used to put `map` directly after this section, and both draw
   * `site.address` into a `.sf-facts` row. So a shop with an address ended its home page on two
   * consecutive bands whose only difference was that the second one also had two buttons: the
   * critic's read was that «موقعنا» is "its own band for an address the section above already
   * printed", and it was right. Two deep links are not a section.
   *
   * `resolveMapTarget` is the SAME fallback chain (coordinates → the section's own query →
   * `Site.mapQuery` → `Site.address`), so this renders exactly when the standalone section would
   * have. `MapSection` is untouched and still available: a merchant who deliberately added «موقعنا»
   * keeps it, and `buildDefaultSections` now only plans one when there is no contact block to fold
   * it into. Stored arrangements are not migrated — see the note there.
   */
  const mapTarget = resolveMapTarget({
    lat: site.mapLat,
    lng: site.mapLng,
    configQuery: null,
    siteQuery: site.mapQuery,
    address: site.address,
  });

  /**
   * A SHOP-level enquiry, not a product one.
   *
   * The product message template takes `{product}` and `{shop}`; feeding the shop name to both
   * produced "بدي أستفسر عن سوبر ماركت الوادي من سوبر ماركت الوادي" — the first sentence a
   * customer sends to the merchant, on the main conversion path of a shop with no product-page
   * traffic. `order.messageShop` exists so there is nothing to substitute twice.
   */
  const template = st('order.messageShop', {
    shop: site.name,
    url: context.origin,
  });

  return (
    <SectionBlock
      anchor={anchor ?? SECTION_ANCHORS.contact_whatsapp}
      title={config.title?.trim() || st('sections.contact')}
      lead={config.body?.trim() || st('contact.body')}
    >
      <div className="sf-contact">
        <div>
          <dl className="sf-facts">
            {site.phone ? (
              <div>
                <dt>
                  <PhoneIcon className="sf-btn__icon" /> {st('contact.phone')}
                </dt>
                <dd>
                  <a href={`tel:${site.phone.replace(/\s/g, '')}`}>{site.phone}</a>
                </dd>
              </div>
            ) : null}
            {hoursLine ? (
              <div>
                <dt>
                  <ClockIcon className="sf-btn__icon" /> {st('contact.hours')}
                </dt>
                <dd>{isolateRanges(hoursLine)}</dd>
              </div>
            ) : null}
            {site.address ? (
              <div>
                <dt>{st('contact.address')}</dt>
                <dd>{site.address}</dd>
              </div>
            ) : null}
            {site.email ? (
              <div>
                <dt>{st('contact.email')}</dt>
                <dd>
                  <a href={`mailto:${site.email}`}>{site.email}</a>
                </dd>
              </div>
            ) : null}
          </dl>

          {/*
            Both links are GHOST buttons. The section's one filled button is «اطلب عبر واتساب» in
            the column beside this one, and a page that fills three buttons in one band has told the
            visitor nothing about which of them it wants pressed.
          */}
          {mapTarget ? (
            <div className="sf-actions">
              <a
                className="sf-btn sf-btn--ghost"
                href={mapTarget.googleUrl}
                rel="noopener noreferrer"
                target="_blank"
              >
                <MapPinIcon className="sf-btn__icon" />
                {st('map.google')}
              </a>
              <a
                className="sf-btn sf-btn--ghost"
                href={mapTarget.wazeUrl}
                rel="noopener noreferrer"
                target="_blank"
              >
                <NavigationIcon className="sf-btn__icon" />
                {st('map.waze')}
              </a>
            </div>
          ) : null}
        </div>

        <div>
          {context.flags.whatsappOrders && number ? (
            <WhatsappOrder
              number={number}
              messageTemplate={template}
              labels={{
                order: config.buttonLabel?.trim() || st('order.whatsapp'),
                quantity: st('order.quantity'),
                increase: st('order.increase'),
                decrease: st('order.decrease'),
                hint: st('order.hint'),
              }}
            />
          ) : (
            /*
              Two DIFFERENT facts, and the old copy conflated them into one false sentence.

              "رقم واتساب غير متوفر حالياً — فيك تتواصل معنا على الهاتف" was wrong twice over. When
              a super admin turns `whatsapp_orders` off, a shop with a perfectly good number told
              its customers the number was unavailable. And when the merchant stored a LOCAL number
              — `059…`, which `normaliseWhatsappNumber` correctly refuses because Bartaa sits in
              the Seam Zone and the country code is genuinely ambiguous — the sentence pointed the
              visitor at a phone number that is frequently not on the page at all, because a
              merchant who filled the WhatsApp field often left `phone` empty. A dead end on the
              main conversion path.

              So: the feature being off is one message, and an unusable stored number is another
              that PRINTS THE NUMBER, letting the customer dial or message it themselves.
            */
            <p className="sf-note">
              {context.flags.whatsappOrders && site.whatsapp
                ? st('order.numberNotUsable', { number: site.whatsapp })
                : st('order.noNumber')}
            </p>
          )}

          {/*
            THE SOCIAL ROW WAS HERE AND IS NOW ONLY IN THE FOOTER (2026-09-06, owner-directed).

            It rendered in both places, so the home page carried two identical «تابعنا» rows a few
            hundred pixels apart — one under the WhatsApp button and one in the footer column below
            it. A repeated control does not read as emphasis, it reads as a template bug, and the
            footer's is the canonical one: it is on EVERY route, whereas this section is on the home
            page only and only while the merchant keeps it in their arrangement.

            `SiteFooter` is the single caller now. If this block ever comes back it has to come back
            as a MOVE, not a copy.
          */}
        </div>
      </div>
    </SectionBlock>
  );
}
