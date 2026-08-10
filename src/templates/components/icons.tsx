import type { SVGProps } from 'react';

/**
 * Inline SVG icons.
 *
 * Emoji as icons is on the forbidden list (CLAUDE.md), and for a good reason beyond taste: an
 * emoji renders as a different picture on every platform, is announced as a word by a screen
 * reader, and has no relationship to the template's colours. These are geometric glyphs drawn
 * on a 24-grid, they inherit `currentColor`, and they are decorative — every one of them sits
 * next to a real Arabic label, so they are `aria-hidden` without exception.
 */

type IconProps = SVGProps<SVGSVGElement>;

function Svg({ children, ...props }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      {children}
    </svg>
  );
}

export function WhatsappIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M20 11.5a8 8 0 0 1-11.9 7L4 20l1.6-3.9A8 8 0 1 1 20 11.5Z" />
      <path d="M8.8 9.2c0 3 2.2 5.2 5.2 5.2l1-1.1-1.7-1-.8.8a4.2 4.2 0 0 1-2.3-2.3l.8-.8-1-1.7-1.2 1Z" />
    </Svg>
  );
}

export function MapPinIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 21s6.5-5.3 6.5-10a6.5 6.5 0 1 0-13 0C5.5 15.7 12 21 12 21Z" />
      <circle cx="12" cy="11" r="2.4" />
    </Svg>
  );
}

export function NavigationIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="m20 4-7.4 16-2-6.6L4 11.4 20 4Z" />
    </Svg>
  );
}

export function StarIcon(props: IconProps) {
  return (
    <Svg fill="currentColor" stroke="none" {...props}>
      <path d="m12 3.6 2.4 4.9 5.4.8-3.9 3.8.9 5.3-4.8-2.5-4.8 2.5.9-5.3-3.9-3.8 5.4-.8L12 3.6Z" />
    </Svg>
  );
}

export function CloseIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="m6 6 12 12M18 6 6 18" />
    </Svg>
  );
}

export function PhoneIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M5 4h3.5l1.5 4-2 1.4a11 11 0 0 0 4.6 4.6L14 12l4 1.5V17c0 1.1-.9 2-2 2A13 13 0 0 1 3 6c0-1.1.9-2 2-2Z" />
    </Svg>
  );
}

export function ClockIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 1.8" />
    </Svg>
  );
}

/**
 * Social glyphs.
 *
 * Deliberately simplified marks rather than reproductions of each company's logo: a storefront
 * footer is not a place to embed eight trademarked vector files, and every one of them sits
 * beside an Arabic label naming the platform anyway.
 */
const SOCIAL_GLYPHS: Record<string, React.ReactNode> = {
  facebook: <path d="M14.5 8H16V5h-2.2C11.7 5 11 6.4 11 8v1.6H9V13h2v6h3v-6h2.2l.4-3.4H14V8.4c0-.3.1-.4.5-.4Z" />,
  instagram: (
    <>
      <rect x="4.5" y="4.5" width="15" height="15" rx="4.5" />
      <circle cx="12" cy="12" r="3.6" />
      <circle cx="16.6" cy="7.4" r="0.9" fill="currentColor" />
    </>
  ),
  tiktok: (
    <>
      <path d="M14 4.5v9.8a3.3 3.3 0 1 1-2.6-3.2" />
      <path d="M14 6.4c.7 1.6 2 2.5 3.8 2.6" />
    </>
  ),
  youtube: (
    <>
      <rect x="3.5" y="6.5" width="17" height="11" rx="3.2" />
      <path d="m10.6 9.8 4.2 2.2-4.2 2.2V9.8Z" fill="currentColor" stroke="none" />
    </>
  ),
  x: <path d="m5 5 14 14M19 5 5 19" />,
  telegram: (
    <>
      <path d="M20 5 3.8 11.3l4.5 1.5L19 6.6l-8.2 8v4l2.6-3.1 4 3 2.6-13.5Z" />
    </>
  ),
  snapchat: (
    <>
      <path d="M12 4.5c2.4 0 3.9 1.7 3.9 4v2.2c.7.4 1.5.2 2 0 .3 1-.6 1.6-1.6 2 .5 1.6 1.9 2.6 3.2 2.9-.6.9-2 1.2-3 1.3-.2.5-.3 1-.6 1.2-.7.3-1.6-.3-2.6-.3-1.4 0-2 1.3-3.3 1.3s-1.9-1.3-3.3-1.3c-1 0-1.9.6-2.6.3-.3-.2-.4-.7-.6-1.2-1-.1-2.4-.4-3-1.3 1.3-.3 2.7-1.3 3.2-2.9-1-.4-1.9-1-1.6-2 .5.2 1.3.4 2 0V8.5c0-2.3 1.5-4 3.9-4Z" />
    </>
  ),
  website: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M3.5 12h17M12 3.5c2.4 2.4 3.6 5.3 3.6 8.5S14.4 18.1 12 20.5c-2.4-2.4-3.6-5.3-3.6-8.5S9.6 5.9 12 3.5Z" />
    </>
  ),
};

export function SocialIcon({ platform, ...props }: IconProps & { platform: string }) {
  const glyph = SOCIAL_GLYPHS[platform] ?? SOCIAL_GLYPHS.website;
  return <Svg {...props}>{glyph}</Svg>;
}

export function hasSocialGlyph(platform: string): boolean {
  return platform in SOCIAL_GLYPHS;
}
