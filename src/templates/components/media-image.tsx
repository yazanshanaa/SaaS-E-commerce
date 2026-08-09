import type { CSSProperties } from 'react';
import type { StorefrontImage } from '../view-model';

/**
 * The only way an image reaches a storefront.
 *
 * `next/image` is deliberately NOT used here. Invariant 4 says public delivery is always
 * CDN-over-R2 and never the app server: `next/image` would route every product photo through
 * the Next optimiser on our own box, re-encoding variants the A3 pipeline has already produced
 * at 400/800/1600 in WebP and AVIF. That is an extra hop, an extra bill, and a second source of
 * truth for image sizes.
 *
 * Two rules this component exists to keep:
 *   - `width` and `height` are ALWAYS set, so the box is reserved before a byte arrives. That
 *     is the CLS budget, and it is spent here once instead of leaking into every section;
 *   - nothing below the fold is eager. `priority` is opt-in and belongs to the hero alone.
 */

export interface MediaImageProps {
  image: StorefrontImage | null;
  /** CSS `aspect-ratio`, e.g. `4 / 3`. Templates override it per surface in their own CSS. */
  ratio?: string;
  sizes?: string;
  /** The hero image only. Everything else lazy-loads. */
  priority?: boolean;
  /** Shown inside the deliberate no-image state — usually the shop or product's first letter. */
  fallbackLabel?: string;
  className?: string;
}

export function MediaImage({
  image,
  ratio,
  sizes = '(max-width: 40rem) 100vw, 33vw',
  priority = false,
  fallbackLabel,
  className,
}: MediaImageProps) {
  const style = ratio ? ({ '--sf-ratio': ratio } as CSSProperties) : undefined;
  const boxClass = className ? `sf-media ${className}` : 'sf-media';

  if (!image) {
    return (
      <div className={boxClass} style={style}>
        <div className="sf-ph">
          {/*
            No alt text and no role: the placeholder carries no information the surrounding
            markup does not already state, so announcing it would only add noise for a screen
            reader. `aria-hidden` is the honest answer, not an empty alt on a fake image.
          */}
          <span className="sf-ph__mark" aria-hidden="true">
            {(fallbackLabel ?? '').trim().slice(0, 1)}
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className={boxClass} style={style}>
      <picture>
        {image.sources.map((source) => (
          <source key={source.type} type={source.type} srcSet={source.srcSet} sizes={sizes} />
        ))}
        <img
          src={image.src}
          alt={image.alt}
          width={image.width}
          height={image.height}
          sizes={sizes}
          loading={priority ? 'eager' : 'lazy'}
          decoding={priority ? 'sync' : 'async'}
          fetchPriority={priority ? 'high' : 'auto'}
        />
      </picture>
    </div>
  );
}
