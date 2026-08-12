import type { SectionConfig } from '@/shared/site-contract';
import { MediaImage } from '../components/media-image';
import { st } from '../i18n';
import { hasContactSection } from '../lib/arrangement';
import { SECTION_ANCHORS } from '../section-anchors';
import type { StorefrontContext } from '../view-model';

/**
 * The hero — three structurally different heroes, chosen by the template, not by a class name.
 *
 *   split  (ديوان)     copy beside a framed portrait image;
 *   stage  (سوق نيون)  a full-bleed image with the copy sitting on the stage beneath it;
 *   ledger (ورشة)      no decorative image at all — a banner strip and a facts list, because a
 *                      builders' merchant's customer wants the hours and the phone number, not
 *                      a photograph of a shelf.
 *
 * This block owns the page's `h1`. It is also the ONLY image on the page allowed to load
 * eagerly: it is the LCP element, and everything below it is lazy.
 */

export interface HeroSectionProps {
  context: StorefrontContext;
  config: SectionConfig<'hero'>;
  /** Unique-per-page override from `SectionList`; falls back to the type's stable anchor. */
  anchor?: string;
}

export function HeroSection({ context, config, anchor }: HeroSectionProps) {
  const { site, template } = context;
  const variant = template.layout.hero;

  const title = config.title?.trim() || site.name;
  const subtitle = config.subtitle?.trim() || site.tagline || site.about;
  const image = config.imageMediaId ? (context.mediaById[config.imageMediaId] ?? null) : null;

  const ctaLabel = config.ctaLabel?.trim() || st('hero.cta');
  const ctaHref = config.ctaHref?.trim() || '/products';
  const align = config.align === 'center' ? 'center' : 'start';

  const copy = (
    <div className="sf-hero__copy" style={align === 'center' ? { textAlign: 'center' } : undefined}>
      <h1 className="sf-hero__title">{title}</h1>
      {subtitle ? <p className="sf-hero__text">{subtitle}</p> : null}
      <div className="sf-hero__actions sf-actions">
        <a className="sf-btn" href={ctaHref}>
          {ctaLabel}
        </a>
        {/* Only when the arrangement has the section it points at — see lib/arrangement.ts. */}
        {hasContactSection(context) ? (
          <a className="sf-btn sf-btn--ghost" href={`#${SECTION_ANCHORS.contact_whatsapp}`}>
            {st('hero.secondary')}
          </a>
        ) : null}
      </div>
    </div>
  );

  if (variant === 'ledger') {
    return (
      <section id={anchor ?? SECTION_ANCHORS.hero} className="sf-hero sf-hero--ledger">
        <div className="sf-shell sf-hero__inner">
          {copy}
          <dl className="sf-hero__facts">
            {site.hours ? (
              <div className="sf-hero__fact">
                <dt>{st('contact.hours')}</dt>
                <dd>{site.hours}</dd>
              </div>
            ) : null}
            {site.phone ? (
              <div className="sf-hero__fact">
                <dt>{st('contact.phone')}</dt>
                <dd>{site.phone}</dd>
              </div>
            ) : null}
            {site.address ? (
              <div className="sf-hero__fact">
                <dt>{st('contact.address')}</dt>
                <dd>{site.address}</dd>
              </div>
            ) : null}
          </dl>
        </div>
      </section>
    );
  }

  if (variant === 'stage') {
    return (
      <section id={anchor ?? SECTION_ANCHORS.hero} className="sf-hero sf-hero--stage">
        <div className="sf-shell">
          <div className="sf-hero__inner">
            <div className="sf-hero__media">
              <MediaImage
                image={image}
                ratio="16 / 9"
                priority
                fallbackLabel={site.name}
                sizes="100vw"
              />
            </div>
            {copy}
          </div>
        </div>
      </section>
    );
  }

  return (
    <section id={anchor ?? SECTION_ANCHORS.hero} className="sf-hero sf-hero--split">
      <div className="sf-shell sf-hero__inner">
        {copy}
        <div className="sf-hero__media">
          <MediaImage
            image={image}
            ratio="4 / 5"
            priority
            fallbackLabel={site.name}
            sizes="(max-width: 60rem) 100vw, 40vw"
          />
        </div>
      </div>
    </section>
  );
}
