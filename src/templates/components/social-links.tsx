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
export function SocialLinks({ links }: { links: StorefrontSocialLink[] }) {
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
