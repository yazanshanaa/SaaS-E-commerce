import type { SectionConfig } from '@/shared/site-contract';
import { StarIcon } from '../components/icons';
import { st } from '../i18n';
import { SECTION_ANCHORS } from '../section-anchors';
import type { StorefrontContext } from '../view-model';
import { SectionBlock } from './block';

/**
 * Customer quotes.
 *
 * The star row is decorative markup with a real text alternative beside it: five identical
 * `aria-hidden` glyphs and one visually-hidden sentence saying "التقييم 4 من 5". Rendering
 * four stars and expecting a screen reader to count them is the version of this that fails an
 * audit.
 */

export interface TestimonialsSectionProps {
  context: StorefrontContext;
  config: SectionConfig<'testimonials'>;
}

export function TestimonialsSection({ context, config }: TestimonialsSectionProps) {
  const quotes = context.testimonials.slice(0, config.limit ?? 3);
  if (quotes.length === 0) return null;

  return (
    <SectionBlock
      anchor={SECTION_ANCHORS.testimonials}
      title={config.title?.trim() || st('sections.testimonials')}
    >
      <ul className="sf-quotes">
        {quotes.map((quote) => (
          <li key={quote.id}>
            <figure className="sf-quote">
              {quote.rating ? (
                <p className="sf-stars">
                  <span className="sf-vh">{st('testimonials.rating', { rating: quote.rating })}</span>
                  {Array.from({ length: Math.min(5, Math.max(1, quote.rating)) }, (_, index) => (
                    <StarIcon key={index} />
                  ))}
                </p>
              ) : null}
              <blockquote className="sf-quote__text">{quote.text}</blockquote>
              <figcaption className="sf-quote__who">{quote.name}</figcaption>
            </figure>
          </li>
        ))}
      </ul>
    </SectionBlock>
  );
}
