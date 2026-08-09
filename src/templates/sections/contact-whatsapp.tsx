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
}

export function ContactWhatsappSection({ context, config }: ContactSectionProps) {
  const { site } = context;
  const number = normaliseWhatsappNumber(site.whatsapp);

  const template = st('order.messageNoPrice', {
    product: site.name,
    shop: site.name,
    url: context.origin,
  });

  return (
    <SectionBlock
      anchor={SECTION_ANCHORS.contact_whatsapp}
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
            <p className="sf-note">{st('order.noNumber')}</p>
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
