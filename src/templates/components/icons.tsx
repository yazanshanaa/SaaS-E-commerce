import type { SVGProps } from 'react';
import { BrandIcon, hasBrandMark } from './brand-icons';

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

/**
 * The real WhatsApp mark (2026-09-15). A stroked bubble-with-handset stood here before; the owner
 * asked for the logo people recognise. Filled, so it inherits `currentColor` exactly like the rest.
 */
export function WhatsappIcon(props: IconProps) {
  return <BrandIcon brand="whatsapp" {...props} />;
}

export function HomeIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 11.5 12 4l8 7.5" />
      <path d="M6 10v10h4.5v-5.5h3V20H18V10" />
    </Svg>
  );
}

export function GridIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="4" y="4" width="6.5" height="6.5" rx="1.2" />
      <rect x="13.5" y="4" width="6.5" height="6.5" rx="1.2" />
      <rect x="4" y="13.5" width="6.5" height="6.5" rx="1.2" />
      <rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.2" />
    </Svg>
  );
}

export function TagIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M3.5 12.5V5a1.5 1.5 0 0 1 1.5-1.5h7.5l8 8-9 9-8-8Z" />
      <circle cx="8.5" cy="8.5" r="1.3" />
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

/** The header search submit. Same 24-grid, same `currentColor`, same decorative contract. */
export function SearchIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="10.8" cy="10.8" r="6.3" />
      <path d="m15.5 15.5 4 4" />
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
 * Phase 9 — the trust row's five glyphs, moved here from `sections/trust-badges.tsx`.
 *
 * They were drawn there against a duplicated copy of `Svg` because this file belonged to no track,
 * and `TrustBadge.icon` defaults to `"check"` — so the platform shipped a default icon with no
 * picture behind it, and a merchant who added a badge without choosing a glyph got a blank.
 *
 * The set is closed and the keys are `TRUST_ICON_KEYS` in `src/server/content/trust-badges.ts`;
 * `tests/unit/phase9-content.test.ts` asserts every one of them resolves to a function, so this move
 * cannot silently lose one and a future addition cannot be half-made.
 */
export function CheckIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="m4.5 12.5 5 5 10-11" />
    </Svg>
  );
}

export function TruckIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M3 7h10v9H3zM13 10h4l3 3v3h-7z" />
      <circle cx="7" cy="18" r="1.8" />
      <circle cx="17" cy="18" r="1.8" />
    </Svg>
  );
}

export function ShieldIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 3.5l7 2.5v5.5c0 4.3-3 7.4-7 9-4-1.6-7-4.7-7-9V6Z" />
      <path d="m8.8 12 2.2 2.2 4.2-4.4" />
    </Svg>
  );
}

export function BoxIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 8.5 12 5l8 3.5v7L12 19l-8-3.5Z" />
      <path d="M4 8.5 12 12l8-3.5M12 12v7" />
    </Svg>
  );
}

export function WalletIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="3.5" y="6.5" width="17" height="11" rx="2.5" />
      <path d="M3.5 10.5h17" />
      <circle cx="16.5" cy="14" r="1.2" fill="currentColor" stroke="none" />
    </Svg>
  );
}

/**
 * Social marks — the real logos from `brand-icons.tsx` for every named platform (2026-09-15,
 * owner-directed); the generic «الموقع الإلكتروني» keeps its globe, drawn here on the same grid.
 */
function GlobeIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M3.5 12h17M12 3.5c2.4 2.4 3.6 5.3 3.6 8.5S14.4 18.1 12 20.5c-2.4-2.4-3.6-5.3-3.6-8.5S9.6 5.9 12 3.5Z" />
    </Svg>
  );
}

export function SocialIcon({ platform, ...props }: IconProps & { platform: string }) {
  return hasBrandMark(platform) ? (
    <BrandIcon brand={platform} {...props} />
  ) : (
    <GlobeIcon {...props} />
  );
}

export function hasSocialGlyph(platform: string): boolean {
  return platform === 'website' || hasBrandMark(platform);
}
