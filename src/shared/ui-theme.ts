/**
 * The private surfaces' theme contract — dark/light mode and the accent colour, for the admin
 * panel and the merchant dashboard.
 *
 * A PER-BROWSER PREFERENCE, deliberately not a database column: the choice is about the screen
 * the person is looking at (an office monitor at noon, a phone in a dark stockroom), not about
 * the account, and two people sharing one merchant login can want opposite answers. Cookies are
 * host-only, so the same cookie name keeps admin.* and app.* independent for free.
 *
 * The server layouts read the cookies and stamp `data-theme` / `data-accent` on the surface
 * root, so the first paint is already themed — no flash and no client-side guessing. The
 * ThemeSwitch component flips the attributes live and rewrites the cookies; a reload agrees
 * with what the person is already seeing.
 *
 * Storefronts are untouched by all of this: templates own their colours (per tenant, guarded by
 * the AA machinery in `site-contract`), and these attributes live only under
 * `[data-surface='admin']` / `[data-surface='app']`.
 */

export const UI_THEME_COOKIE = 'sb-ui-theme';
export const UI_ACCENT_COOKIE = 'sb-ui-accent';

/** One year — a preference, not a session. */
export const UI_THEME_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

export type UiTheme = 'light' | 'dark';

/**
 * THE DEFAULT MODE WHEN NO COOKIE HAS BEEN SET — dark, since «مرصد» (2026-08-30).
 *
 * Owner decision, recorded in `DESIGN_BRIEF.md`: the direction is designed dark-first, and both
 * surfaces default to it. Light is a COMPLETE peer, not a fallback — a merchant works in a lit
 * shop by day and the switch must stay one click away — but the shipped first impression is the
 * ground the palette was drawn on.
 *
 * Defined once here rather than defaulted separately in each layout, which is how the two
 * surfaces silently disagreed about anything before.
 */
export const UI_THEME_DEFAULT: UiTheme = 'dark';

/**
 * The five vetted accents. `sea` is the shipped accent for BOTH surfaces since «مرصد» — its
 * blocks restate the base tokens, so choosing it after another accent returns the person to the
 * default look without a cookie-clearing special case.
 *
 * `dot` is what the picker swatch shows. It is the DARK-mode text-level value now, because dark
 * is the default mode: a swatch has to look like what the person will get. The full palettes —
 * light + dark, text-level + solid-fill + tint — live in each surface's CSS next to the tokens
 * they override, because that is where a reviewer checks contrast. Every pairing there clears
 * WCAG AA for its role: `--sb*-on-solid` over the solid fill, the text-level value on both papers.
 */
export const UI_ACCENTS = [
  { key: 'sea', dot: '#5fd3a8' },
  { key: 'clay', dot: '#e0854e' },
  { key: 'olive', dot: '#a7c283' },
  { key: 'night', dot: '#8fb2dd' },
  { key: 'berry', dot: '#e389a4' },
] as const;

export type UiAccentKey = (typeof UI_ACCENTS)[number]['key'];

export function isUiTheme(value: string | undefined): value is UiTheme {
  return value === 'light' || value === 'dark';
}

export function isUiAccentKey(value: string | undefined): value is UiAccentKey {
  return UI_ACCENTS.some((accent) => accent.key === value);
}
