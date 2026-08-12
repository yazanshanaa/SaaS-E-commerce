import type { SectionConfig } from '@/shared/site-contract';
import { ClockIcon, PhoneIcon } from '../components/icons';
import { SocialLinks } from '../components/social-links';
import { WhatsappOrder } from '../components/whatsapp-order';
import { st } from '../i18n';
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
            {site.hours ? (
              <div>
                <dt>
                  <ClockIcon className="sf-btn__icon" /> {st('contact.hours')}
                </dt>
                <dd>{site.hours}</dd>
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

          {context.socialLinks.length > 0 ? (
            <div style={{ marginBlockStart: 'var(--t-space-lg)' }}>
              <h3 className="sf-block__lead">{st('social.title')}</h3>
              <SocialLinks links={context.socialLinks} />
            </div>
          ) : null}
        </div>
      </div>
    </SectionBlock>
  );
}
