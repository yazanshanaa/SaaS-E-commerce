import type { SVGProps } from 'react';

/**
 * The kit's icon set (Phase 11, Track 11.F) — one inline SVG per nav key, 20px grid, 1.75px
 * stroke, `currentColor`, always `aria-hidden`: the LABEL is the accessible name and an icon
 * never replaces text (the phase plan's own rule, and CLAUDE.md's ban on emoji-as-icons made
 * mechanical). Both private surfaces read from this one file; the storefront never does.
 */

type IconProps = SVGProps<SVGSVGElement>;

function Svg({ children, ...props }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      viewBox="0 0 20 20"
      width={20}
      height={20}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {children}
    </svg>
  );
}

export const KIT_ICONS: Record<string, (props: IconProps) => React.ReactElement> = {
  home: (p) => (
    <Svg {...p}>
      <path d="M3.5 9.5 10 3.5l6.5 6v6.5a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1Z" />
      <path d="M8 17v-4.5h4V17" />
    </Svg>
  ),
  products: (p) => (
    <Svg {...p}>
      <path d="M3.5 6.5 10 3l6.5 3.5v7L10 17l-6.5-3.5Z" />
      <path d="M3.5 6.5 10 10l6.5-3.5M10 10v7" />
    </Svg>
  ),
  orders: (p) => (
    <Svg {...p}>
      <path d="M5.5 3.5h9v13l-1.5-1-1.5 1-1.5-1-1.5 1-1.5-1-1.5 1Z" />
      <path d="M8 7h4M8 10h4" />
    </Svg>
  ),
  media: (p) => (
    <Svg {...p}>
      <rect x="3.5" y="4.5" width="13" height="11" rx="1.5" />
      <circle cx="7.5" cy="8.5" r="1.25" />
      <path d="m3.5 13.5 3.5-3 3 2.5 3-3 3.5 3" />
    </Svg>
  ),
  appearance: (p) => (
    <Svg {...p}>
      <path d="M10 3.5a6.5 6.5 0 1 0 0 13c1.2 0 1.6-.9 1.1-1.7-.6-1 .1-2.3 1.4-2.3h1.7c1.3 0 2.3-1 2.3-2.5C16.5 6 13.6 3.5 10 3.5Z" />
      <circle cx="7" cy="8" r="0.5" />
      <circle cx="10.5" cy="6.5" r="0.5" />
      <circle cx="6.5" cy="11.5" r="0.5" />
    </Svg>
  ),
  sections: (p) => (
    <Svg {...p}>
      <rect x="3.5" y="3.5" width="13" height="4" rx="1" />
      <rect x="3.5" y="9.5" width="6" height="7" rx="1" />
      <rect x="11.5" y="9.5" width="5" height="7" rx="1" />
    </Svg>
  ),
  content: (p) => (
    <Svg {...p}>
      <path d="M4.5 16.5h11M4.5 3.5h8l3 3v7" />
      <path d="M12.5 3.5v3h3M7 9h6M7 12h6" />
    </Svg>
  ),
  settings: (p) => (
    <Svg {...p}>
      <circle cx="10" cy="10" r="2.5" />
      <path d="M10 3.5v2M10 14.5v2M3.5 10h2M14.5 10h2M5.4 5.4l1.4 1.4M13.2 13.2l1.4 1.4M14.6 5.4l-1.4 1.4M6.8 13.2l-1.4 1.4" />
    </Svg>
  ),
  notifications: (p) => (
    <Svg {...p}>
      <path d="M10 3.5a4.5 4.5 0 0 0-4.5 4.5c0 3.5-1.5 4.5-1.5 4.5h12s-1.5-1-1.5-4.5A4.5 4.5 0 0 0 10 3.5Z" />
      <path d="M8.5 15.5a1.5 1.5 0 0 0 3 0" />
    </Svg>
  ),
  analytics: (p) => (
    <Svg {...p}>
      <path d="M4 16V9M8 16V4M12 16v-5M16 16V7" />
    </Svg>
  ),
  insights: (p) => (
    <Svg {...p}>
      <path d="M2.5 10S5 5.5 10 5.5 17.5 10 17.5 10 15 14.5 10 14.5 2.5 10 2.5 10Z" />
      <circle cx="10" cy="10" r="2" />
    </Svg>
  ),
  coupons: (p) => (
    <Svg {...p}>
      <path d="M3.5 8V5.5h13V8a2 2 0 0 0 0 4v2.5h-13V12a2 2 0 0 0 0-4Z" />
      <path d="M8 5.5v9" strokeDasharray="1.5 2" />
    </Svg>
  ),
  delivery: (p) => (
    <Svg {...p}>
      <path d="M3.5 5.5h8v8h-8ZM11.5 8.5h3l2 2v3h-5" />
      <circle cx="6.5" cy="15" r="1.5" />
      <circle cx="14" cy="15" r="1.5" />
    </Svg>
  ),
  tax: (p) => (
    <Svg {...p}>
      <rect x="4.5" y="3.5" width="11" height="13" rx="1" />
      <path d="M7.5 7.5h5M7.5 10.5h5M7.5 13.5h2.5" />
    </Svg>
  ),
  customers: (p) => (
    <Svg {...p}>
      <circle cx="7.5" cy="7" r="2.5" />
      <path d="M3 16c0-2.5 2-4 4.5-4s4.5 1.5 4.5 4" />
      <circle cx="14" cy="8" r="2" />
      <path d="M13 12.5c2.3 0 4 1.4 4 3.5" />
    </Svg>
  ),
  staff: (p) => (
    <Svg {...p}>
      <circle cx="10" cy="6.5" r="2.5" />
      <path d="M5 16.5c0-2.8 2.2-4.5 5-4.5s5 1.7 5 4.5" />
      <path d="M10 12v4.5" />
    </Svg>
  ),
  billing: (p) => (
    <Svg {...p}>
      <rect x="3" y="5.5" width="14" height="9.5" rx="1.5" />
      <path d="M3 8.5h14M6 12.5h3" />
    </Svg>
  ),
  // --- the admin rail -------------------------------------------------------
  overview: (p) => (
    <Svg {...p}>
      <path d="M4 12.5a6 6 0 1 1 12 0" />
      <path d="M10 12.5 13 9" />
      <path d="M3 15.5h14" />
    </Svg>
  ),
  accounts: (p) => (
    <Svg {...p}>
      <path d="M4.5 16.5v-11l5.5-2 5.5 2v11" />
      <path d="M3 16.5h14M8 8h1.5M8 11h1.5M11.5 8H13M11.5 11H13" />
    </Svg>
  ),
  lifecycle: (p) => (
    <Svg {...p}>
      <path d="M16 10a6 6 0 1 1-2-4.5" />
      <path d="M16 3.5v3h-3" />
      <path d="M10 7v3.5l2.5 1.5" />
    </Svg>
  ),
  demos: (p) => (
    <Svg {...p}>
      <rect x="3.5" y="4.5" width="13" height="9" rx="1" />
      <path d="M8 16.5h4M10 13.5v3" />
      <path d="m8.5 8 2-2 1.5 3 1.5-1.5" />
    </Svg>
  ),
  changeRequests: (p) => (
    <Svg {...p}>
      <path d="M3.5 11.5h4l1 2h3l1-2h4" />
      <path d="M4.5 6.5h11l1 5v4h-13v-4Z" />
    </Svg>
  ),
  plans: (p) => (
    <Svg {...p}>
      <path d="m10 3 6.5 3.5L10 10 3.5 6.5Z" />
      <path d="m3.5 10 6.5 3.5 6.5-3.5M3.5 13.5 10 17l6.5-3.5" />
    </Svg>
  ),
  carriers: (p) => (
    <Svg {...p}>
      <path d="M3.5 5.5h8v8h-8ZM11.5 8.5h3l2 2v3h-5" />
      <circle cx="6.5" cy="15" r="1.5" />
      <circle cx="14" cy="15" r="1.5" />
    </Svg>
  ),
  privacy: (p) => (
    <Svg {...p}>
      <path d="M10 3.5 4.5 5.5v4c0 3.5 2.3 6 5.5 7 3.2-1 5.5-3.5 5.5-7v-4Z" />
      <path d="m7.5 9.5 2 2 3-3.5" />
    </Svg>
  ),
  audit: (p) => (
    <Svg {...p}>
      <rect x="4.5" y="3.5" width="11" height="13" rx="1" />
      <path d="m7 8 1 1 2-2M7 12.5l1 1 2-2M12 8.5h1.5M12 13h1.5" />
    </Svg>
  ),
  backups: (p) => (
    <Svg {...p}>
      <ellipse cx="10" cy="5.5" rx="6" ry="2" />
      <path d="M4 5.5v9c0 1.1 2.7 2 6 2s6-.9 6-2v-9" />
      <path d="M4 10c0 1.1 2.7 2 6 2s6-.9 6-2" />
    </Svg>
  ),
};

/** Chrome glyphs (not nav keys). */
export function MenuIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M3.5 6h13M3.5 10h13M3.5 14h13" />
    </Svg>
  );
}

export function CloseIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="m5 5 10 10M15 5 5 15" />
    </Svg>
  );
}

export function SearchIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="9" cy="9" r="5" />
      <path d="m13 13 3.5 3.5" />
    </Svg>
  );
}

export function CollapseIcon(props: IconProps) {
  return (
    <Svg {...props}>
      {/* Points toward the inline END (left in RTL) — the direction the rail folds. */}
      <path d="m11.5 5.5-4 4.5 4 4.5M8 10h8.5" />
    </Svg>
  );
}

export function NavIcon({ name, ...props }: IconProps & { name: string }) {
  const Icon = KIT_ICONS[name];
  return Icon ? <Icon {...props} /> : null;
}
