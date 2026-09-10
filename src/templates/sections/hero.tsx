import type { SectionConfig } from '@/shared/site-contract';
import { isolateRanges } from '../lib/ltr-ranges';
import { MediaImage } from '../components/media-image';
import { pluralCount, st } from '../i18n';
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
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * PHASE 12.E — THE NO-PHOTOGRAPH HERO, and why it is the most important change in this file.
 *
 * `split` and `stage` both rendered `MediaImage` UNCONDITIONALLY, and `MediaImage` answers a null
 * image with a reserved placeholder box. That is exactly right inside a product grid, where the box
 * holds a slot in a row of real photographs. It is exactly wrong here, because the hero's box is
 * 40vw wide and the full height of the first screen — so a shop that has not uploaded a hero image
 * opened on a placeholder the size of a door, with the shop's name small beside it.
 *
 * That is not an edge case. It is the FIRST DAY OF EVERY ACCOUNT, and the 2026-09-08 capture caught
 * it on a live tenant: roughly 500px of empty plate above the fold, before the visitor reached the
 * shop's name. The old code could not do better — a component that always renders a figure has no
 * way to express "there is no figure".
 *
 * So the hero now asks whether it HAS a photograph and renders a different composition either way:
 *
 *   data-figure="photo"  the image leads, the copy sits with it (what the code always assumed);
 *   data-figure="type"   there is no image and none is faked. The copy takes the whole band on the
 *                        tinted ground, set larger, with the proof strip under it. A typographic
 *                        hero is a deliberate design; a placeholder the size of a door is not.
 *
 * THE PROOF STRIP carries only facts the shop can prove — the catalogue count it really has, the
 * departments it really has, and whether it really takes orders on WhatsApp. The reference this was
 * designed against anchors its hero on «4.9 ★ / 48h / 100%», and this platform must not: a rating
 * nobody collected and a delivery time nobody promised are a small lie printed in the merchant's own
 * voice. Counts are free, true, and answer the same question a visitor is actually asking — is there
 * anything here.
 */

export interface HeroSectionProps {
  context: StorefrontContext;
  config: SectionConfig<'hero'>;
  /** Unique-per-page override from `SectionList`; falls back to the type's stable anchor. */
  anchor?: string;
}

/**
 * The honest proof strip. Renders nothing at all on a shop with an empty catalogue — an empty
 * strip under the name of a new shop advertises the emptiness, which is worse than the absence.
 */
function HeroProof({ context }: { context: StorefrontContext }) {
  const facts: string[] = [];

  if (context.productTotal > 0) facts.push(pluralCount('products.count', context.productTotal));
  if (context.categories.length > 0) {
    facts.push(pluralCount('categories.count', context.categories.length));
  }
  /*
    WhatsApp is the conversion on this platform, not a contact form (design/taste.md), so its
    availability is a fact worth stating beside the counts rather than only in the floating button.
    Keyed on the resolved flag AND a stored number, the same pair `whatsapp-fab.tsx` requires.
  */
  if (context.flags.whatsappOrders && context.site.whatsapp) facts.push(st('hero.proofWhatsapp'));

  if (facts.length === 0) return null;

  return (
    <ul className="sf-hero__proof" aria-label={st('hero.proofLabel')}>
      {facts.map((fact) => (
        <li key={fact}>{fact}</li>
      ))}
    </ul>
  );
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

  /*
    THE ONE QUESTION THE OLD COMPONENT NEVER ASKED. Everything below branches on it — see the note
    at the top of the file. `ledger` is excluded by construction: it is the hero that was always
    defined as having no decorative image, so it is `type` whether or not a media id was stored.
  */
  const hasPhoto = variant !== 'ledger' && image !== null;

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
      {/*
        The strip belongs to the COPY, not to the section, so it lands under the buttons in every
        variant without each one having to place it — including `stage`, where the copy sits on the
        image, and the typographic heroes, where it is the only thing anchoring the band.
      */}
      <HeroProof context={context} />
    </div>
  );

  if (variant === 'ledger') {
    /*
      AN EMPTY `<dl>` IS NOT AN EMPTY ELEMENT — it is a 2px hairline bar.

      `.sf-hero__facts` is a bordered grid with a `--t-border` background showing through 1px gaps, so
      a shop with no hours, no phone AND no address rendered the frame with nothing in it: a stray
      rule across the first screen that reads as a broken component. `ledger` is ورشة's hero and the
      facts ARE its content, so the honest answer when there are none is to render no pad at all and
      let the copy take the band.
    */
    const hasFacts = Boolean(site.hours || site.phone || site.address);

    return (
      <section
        id={anchor ?? SECTION_ANCHORS.hero}
        className="sf-hero sf-hero--ledger"
        data-figure="type"
      >
        <div className="sf-shell sf-hero__inner">
          {copy}
          {hasFacts ? (
            <dl className="sf-hero__facts">
              {site.hours ? (
                <div className="sf-hero__fact">
                  <dt>{st('contact.hours')}</dt>
                  <dd>{isolateRanges(site.hours)}</dd>
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
          ) : null}
        </div>
      </section>
    );
  }

  if (variant === 'stage') {
    return (
      <section
        id={anchor ?? SECTION_ANCHORS.hero}
        className="sf-hero sf-hero--stage"
        data-figure={hasPhoto ? 'photo' : 'type'}
      >
        <div className="sf-shell">
          <div className="sf-hero__inner">
            {/*
              NO BOX WHEN THERE IS NO PHOTOGRAPH. The stage's image is full-bleed and 16:9 — at
              1440px that is an 810px-tall placeholder standing between the visitor and the shop's
              name. The typographic stage below is a composition; this would have been an apology.
            */}
            {hasPhoto ? (
              <div className="sf-hero__media">
                <MediaImage
                  image={image}
                  ratio="16 / 9"
                  priority
                  fallbackLabel={site.name}
                  sizes="100vw"
                />
              </div>
            ) : null}
            {copy}
          </div>
        </div>
      </section>
    );
  }

  return (
    <section
      id={anchor ?? SECTION_ANCHORS.hero}
      className="sf-hero sf-hero--split"
      data-figure={hasPhoto ? 'photo' : 'type'}
    >
      <div className="sf-shell sf-hero__inner">
        {copy}
        {hasPhoto ? (
          <div className="sf-hero__media">
            <MediaImage
              image={image}
              ratio="4 / 5"
              priority
              fallbackLabel={site.name}
              sizes="(max-width: 60rem) 100vw, 40vw"
            />
          </div>
        ) : null}
      </div>
    </section>
  );
}
