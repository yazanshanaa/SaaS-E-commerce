import { st } from '../i18n';
import type { StorefrontSocialLink } from '../view-model';
import { SocialIcon } from './icons';

/**
 * Social links — a site-level element, extensible, and only the POPULATED ones render.
 *
 * The zero-links case is the normal one, not the edge case: every demo tenant has none, and so
 * does every account on its first day. So the caller decides what to put in that column
 * instead (see `site-footer.tsx`, which shows the contact details there) and this component
 * simply returns nothing. An empty "تابعنا" heading over blank space is the thing that looks
 * broken, and it is exactly what you get if you render the heading before checking the list.
 *
 * A platform with no glyph still renders, with the globe mark and its own Arabic label — the
 * list is meant to grow without a code change here.
 */
/**
 * A stored URL is not a URL until something checks it.
 *
 * `SocialLink.url` is a bare `String` column: nothing between the row and this anchor validates
 * it, and "instagram.com/souq-bartaa" — with no scheme, which is how people actually paste a
 * profile address — becomes a RELATIVE link. The visitor lands on
 * `{shop}.souqbartaa.com/instagram.com/souq-bartaa`, which 404s, from an icon that promised
 * Instagram. A `javascript:` value is neutralised by React, but relying on the framework for that
 * is luck rather than design, and it does nothing about the scheme-less case.
 *
 * A link that cannot be trusted is not rendered at all: an icon leading nowhere is worse than an
 * absent icon, and the footer already handles an empty list as its normal state.
 */
export function isRenderableSocialUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

export function SocialLinks({ links: stored }: { links: StorefrontSocialLink[] }) {
  /**
   * The loader has already dropped unrenderable rows, so this is a backstop — the component is
   * exported for B2's live preview, which builds its own view model. It stays here because the
   * callers decide whether to render the "تابعنا" heading from `links.length`, and a heading
   * over an empty list is the exact thing this component was written to avoid.
   */
  const links = stored.filter((link) => isRenderableSocialUrl(link.url));
  if (links.length === 0) return null;

  return (
    <ul className="sf-social">
      {links.map((link) => {
        // A named platform gets its Arabic name; anything unknown falls back to "الموقع
        // الإلكتروني" rather than throwing a missing-message error at a visitor.
        const name = platformLabel(link.platform);
        return (
          <li key={`${link.platform}-${link.url}`}>
            <a
              href={link.url}
              rel="noopener noreferrer nofollow"
              target="_blank"
              /* The icon is decorative, so the accessible name has to come from here. */
              aria-label={st('social.openOn', { platform: name })}
              title={name}
            >
              <SocialIcon platform={link.platform} />
            </a>
          </li>
        );
      })}
    </ul>
  );
}

const KNOWN = new Set([
  'facebook',
  'instagram',
  'tiktok',
  'youtube',
  'x',
  'telegram',
  'snapchat',
  'website',
]);

export function platformLabel(platform: string): string {
  return st(`social.${KNOWN.has(platform) ? platform : 'website'}`);
}
