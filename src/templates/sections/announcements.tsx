import type { SectionConfig } from '@/shared/site-contract';
import { MediaImage } from '../components/media-image';
import { st } from '../i18n';
import { SECTION_ANCHORS } from '../section-anchors';
import type { StorefrontContext } from '../view-model';
import { SectionBlock } from './block';

/**
 * The announcements board — offer cards with a title, text, an optional image, and START and
 * END scheduling that matches the top bar exactly.
 *
 * The scheduling is applied in the DATA LOADER, not here: a card outside its window is never
 * fetched, so it never reaches the HTML. Filtering in the component would leave next month's
 * price in the page source of a site anyone can view-source — which is a real problem for a
 * merchant whose whole promotion depends on the offer being new on Thursday.
 *
 * Scheduling exists on every plan. What متجر buys is the `editable_by` flip on
 * `announcements_board`, not the feature itself (docs/PHASES.md, capability table).
 */

export interface AnnouncementsSectionProps {
  context: StorefrontContext;
  config: SectionConfig<'announcements'>;
}

export function AnnouncementsSection({ context, config }: AnnouncementsSectionProps) {
  const cards = context.announcements.slice(0, config.limit ?? 3);
  if (cards.length === 0) return null;

  return (
    <SectionBlock
      anchor={SECTION_ANCHORS.announcements}
      title={config.title?.trim() || st('sections.announcements')}
    >
      <div className="sf-offers">
        {cards.map((card) => (
          <article className="sf-offer" key={card.id}>
            {card.image ? (
              <MediaImage
                image={card.image}
                ratio="16 / 9"
                fallbackLabel={card.title}
                sizes="(max-width: 40rem) 100vw, 33vw"
              />
            ) : null}
            <h3 className="sf-offer__title">{card.title}</h3>
            {card.body ? <p className="sf-offer__body">{card.body}</p> : null}
            {card.link ? (
              <p>
                {/*
                  Its own string, not the product-detail one. An offer card is not a product: a
                  merchant linking the terms of "خصم 20% على الأجبان البلدية" would have been
                  offering the visitor "تفاصيل المنتج" for a product that does not exist — on the
                  main conversion path of a shop whose whole promotion is this board.
                */}
                <a
                  className="sf-btn sf-btn--ghost"
                  href={card.link}
                  target="_blank"
                  rel="noopener noreferrer nofollow"
                >
                  {st('announcements.details')}
                </a>
              </p>
            ) : null}
          </article>
        ))}
      </div>
    </SectionBlock>
  );
}
