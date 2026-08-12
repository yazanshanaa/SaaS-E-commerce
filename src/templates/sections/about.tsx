import type { SectionConfig } from '@/shared/site-contract';
import { MediaImage } from '../components/media-image';
import { st } from '../i18n';
import { SECTION_ANCHORS } from '../section-anchors';
import type { StorefrontContext } from '../view-model';
import { SectionBlock } from './block';

/**
 * "من نحن".
 *
 * The body falls back to `Site.about`, which is where the text actually lives for every account
 * created by A1 and every demo built from a pack — the section config is the OVERRIDE, not the
 * source. Getting that the wrong way round is how a demo ends up with an empty about block
 * beside a perfectly good paragraph sitting in the database.
 *
 * Paragraphs are split on blank lines rather than rendered as one block: merchants type into a
 * textarea and press Enter, and a wall of text is the result of respecting that too literally.
 */

export interface AboutSectionProps {
  context: StorefrontContext;
  config: SectionConfig<'about'>;
  /** Unique-per-page override from `SectionList`; falls back to the type's stable anchor. */
  anchor?: string;
}

export function AboutSection({ context, config, anchor }: AboutSectionProps) {
  const body = config.body?.trim() || context.site.about?.trim();
  if (!body) return null;

  const image = config.imageMediaId ? (context.mediaById[config.imageMediaId] ?? null) : null;
  const paragraphs = body.split(/\n\s*\n/).filter((p) => p.trim().length > 0);

  return (
    <SectionBlock
      anchor={anchor ?? SECTION_ANCHORS.about}
      title={config.title?.trim() || st('sections.about')}
    >
      <div className="sf-contact">
        <div className="sf-prose">
          {paragraphs.map((paragraph, index) => (
            <p key={index}>{paragraph.trim()}</p>
          ))}
        </div>
        {image ? (
          <MediaImage
            image={image}
            ratio="4 / 3"
            fallbackLabel={context.site.name}
            sizes="(max-width: 60rem) 100vw, 40vw"
          />
        ) : null}
      </div>
    </SectionBlock>
  );
}
