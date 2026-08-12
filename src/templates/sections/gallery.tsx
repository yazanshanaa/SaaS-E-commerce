import type { CSSProperties } from 'react';
import type { SectionConfig } from '@/shared/site-contract';
import { MediaImage } from '../components/media-image';
import { st } from '../i18n';
import { SECTION_ANCHORS } from '../section-anchors';
import type { StorefrontContext } from '../view-model';
import { SectionBlock } from './block';

/**
 * The gallery.
 *
 * Renders nothing when the merchant has selected no media — an empty "من داخل المتجر" heading
 * over a blank strip reads as a broken page, and this section is optional by nature. Ids that
 * no longer resolve (media deleted from the library after the section was configured) are
 * skipped rather than rendered as placeholders, because a wall of placeholder tiles is worse
 * than a shorter gallery.
 */

export interface GallerySectionProps {
  context: StorefrontContext;
  config: SectionConfig<'gallery'>;
  /** Unique-per-page override from `SectionList`; falls back to the type's stable anchor. */
  anchor?: string;
}

export function GallerySection({ context, config, anchor }: GallerySectionProps) {
  const images = (config.mediaIds ?? [])
    .map((id) => context.mediaById[id])
    .filter((image): image is NonNullable<typeof image> => Boolean(image));

  if (images.length === 0) return null;

  return (
    <SectionBlock
      anchor={anchor ?? SECTION_ANCHORS.gallery}
      title={config.title?.trim() || st('sections.gallery')}
    >
      <ul className="sf-gallery" style={{ '--sf-cols': config.columns ?? 3 } as CSSProperties}>
        {images.map((image, index) => (
          <li key={`${image.src}-${index}`}>
            <MediaImage image={image} ratio="1 / 1" sizes="(max-width: 40rem) 50vw, 25vw" />
          </li>
        ))}
      </ul>
    </SectionBlock>
  );
}
