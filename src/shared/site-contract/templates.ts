/**
 * The template registry contract.
 *
 * `src/templates` implements these; A1 and B2 only ever need their KEYS (to validate a
 * `templates_allowed` entitlement and to render a picker), which is why the keys live here and
 * the implementations live in `src/templates`. A1 reading template keys out of A2's folder
 * would couple two worktrees that merge at different times.
 *
 * Fonts are per template and self-hosted, subset to Arabic. Never Inter / Poppins / Roboto
 * (CLAUDE.md design rules).
 */

/**
 * ORDER IS APPEND-ONLY, and the first three keys never move.
 *
 * `templates_allowed` pins a live tenant to a key — أساسي carries exactly one, set at onboarding —
 * so removing or renaming one strands a shop on a template that no longer exists, which
 * `getTemplate()` then answers with the fallback: a merchant's storefront silently becomes a
 * different design. Phase 9 (Q21) therefore ADDS `bayt` and `raff` and reworks the other three in
 * place rather than retiring any of them.
 *
 * The order is also the picker's order, in three surfaces (`/admin/accounts/new`,
 * `/admin/plans`, the merchant's appearance screen), none of which sorts. New keys go last so an
 * existing merchant's choice does not move under their cursor after a deploy.
 */
export const TEMPLATE_KEYS = [
  'diwan',
  'neon-souq',
  'warsheh',
  'bayt',
  'raff',
  // Phase 11 (Q27/Q31): «دار» at the amera-tira quality bar, then three verticals the set did not
  // serve. Appended, never inserted — the array order is the picker order in three surfaces and
  // `prisma/seed.ts` derives `Template.sortOrder` from `indexOf(key)`.
  'aldar',
  'matbakh',
  'mawid',
  'jihaz',
] as const;
export type TemplateKey = (typeof TEMPLATE_KEYS)[number];

export interface TemplateDescriptor {
  key: TemplateKey;
  /** Arabic — shown in the picker. */
  name: string;
  description: string;
  /**
   * The folder under `public/fonts/`, which is also asserted to equal the implementation's
   * `font.dir` (`tests/unit/a2-templates.test.ts`). There are three faces on disk and five
   * templates, so two of these repeat — deliberately paired so the two templates sharing a face
   * are the two least confusable with each other (see each `definition.ts`). Adding a fourth face
   * means adding a subset woff2 pair to `public/fonts/` first; a `fontKey` naming a folder that is
   * not there is an invisible fallback to a system font, not a missing feature.
   *
   * `rubik` is the fourth face (Phase 11, Q32) — CLAUDE.md already allows it, «دار» takes it, and
   * its `@font-face` lives in `aldar.css` and nowhere else (declared-once rule in
   * `tests/unit/phase9-templates.test.ts`).
   */
  fontKey: 'zain' | 'alexandria' | 'ibm-plex-sans-arabic' | 'rubik';
  /** The personality `src/templates` must actually build; recorded here so the five stay distinct. */
  defaults: {
    primary: string;
    secondary: string;
    background: string;
  };
}

export const TEMPLATES: Record<TemplateKey, TemplateDescriptor> = {
  diwan: {
    key: 'diwan',
    name: 'ديوان',
    description: 'دافئ وعائلي، مناسب للبقالات والمحلات العامة',
    fontKey: 'zain',
    defaults: { primary: '#C2410C', secondary: '#5F6F3E', background: '#FAF3E7' },
  },
  'neon-souq': {
    key: 'neon-souq',
    name: 'سوق نيون',
    description: 'جريء وعصري، مناسب للأزياء والإكسسوارات',
    fontKey: 'alexandria',
    defaults: { primary: '#E11D48', secondary: '#F4C95D', background: '#0F0B10' },
  },
  warsheh: {
    key: 'warsheh',
    name: 'ورشة',
    description: 'صارم وعملي، مناسب لمواد البناء والمعدات',
    fontKey: 'ibm-plex-sans-arabic',
    defaults: { primary: '#F59E0B', secondary: '#8A93A3', background: '#171B21' },
  },
  /*
    Phase 9, Q21. Two directions the first three do not cover: a shop whose PHOTOGRAPHS are the
    product, and a shop with four hundred SKUs and no photographs at all.

    The default colours are the design values from `src/templates/{bayt,raff}/definition.ts`, and
    they were chosen against the guard rather than by eye: both clear the BODY-TEXT threshold
    (4.5:1) on the page, on a card and on the footer's surface-alt, so `deriveColorTokens` returns
    them unchanged and the shipped shop is the shop in the design file. The three above predate
    `--t-link` / `--t-accent` and two of them do get walked — سوق نيون's rose and ورشة's steel — which
    is exactly the failure those tokens exist to absorb.

    They are NOT mirrored in `COLOR_PRESETS`: the five presets there are the أساسي picker's own
    vetted sets and three of them happen to match the three original templates. Adding two more
    would change what a basic-plan merchant is offered, which is a product decision and not this
    track's.
  */
  bayt: {
    key: 'bayt',
    name: 'بيت',
    description: 'هادي وأنيق بصور كبيرة، مناسب للألبسة وأدوات البيت',
    fontKey: 'alexandria',
    defaults: { primary: '#E08A5F', secondary: '#CDBBA0', background: '#221913' },
  },
  raff: {
    key: 'raff',
    name: 'رفّ',
    description: 'مرتّب وكثيف يبيّن الأسعار، مناسب للبقالات والصيدليات ومحلات العدد',
    fontKey: 'zain',
    defaults: { primary: '#116149', secondary: '#A3320F', background: '#EDEFEB' },
  },
  /*
    Phase 11 (Q27/Q31). Four more, appended. Every default set below was chosen AGAINST the guard,
    the way bayt/raff were: primary and secondary clear the BODY-TEXT threshold (4.5:1) on the page,
    the card and the footer's surface-alt, so `deriveColorTokens` returns them unchanged and the
    shipped shop is the shop in the design file. Verified numerically — the derived reference values
    are written out in each `src/templates/{key}/definition.ts` and asserted by
    `tests/unit/phase9-templates.test.ts`.
  */
  aldar: {
    key: 'aldar',
    name: 'دار',
    description: 'دافئ ومطمئن بلمسة مرسومة، مناسب للألبسة وأغراض البيت',
    fontKey: 'rubik',
    defaults: { primary: '#AD532C', secondary: '#637357', background: '#FBF4EC' },
  },
  matbakh: {
    key: 'matbakh',
    name: 'مطبخ',
    description: 'شهي ومباشر يليق بقوائم الطعام، مناسب للمطاعم والمخابز والحلويات',
    fontKey: 'zain',
    defaults: { primary: '#A62B1F', secondary: '#57683B', background: '#FFF7EE' },
  },
  mawid: {
    key: 'mawid',
    name: 'موعد',
    description: 'هادئ ومرتّب يقدّم الخدمات والمواعيد، مناسب للصالونات والعيادات والورش',
    fontKey: 'ibm-plex-sans-arabic',
    defaults: { primary: '#0E6B5B', secondary: '#8A4A67', background: '#F2F6F5' },
  },
  jihaz: {
    key: 'jihaz',
    name: 'جهاز',
    description: 'تقني وواضح يقارن المواصفات، مناسب للإلكترونيات والأجهزة والهواتف',
    fontKey: 'rubik',
    defaults: { primary: '#58B7E6', secondary: '#8FD0A9', background: '#0D1420' },
  },
};

export function isTemplateKey(value: string): value is TemplateKey {
  return (TEMPLATE_KEYS as readonly string[]).includes(value);
}

/**
 * The `templates_allowed` feature value is a string[]. أساسي carries exactly one key, set per
 * tenant at onboarding; متجر and احترافي carry all of them — `prisma/seed.ts` spells that as
 * `Object.keys(TEMPLATES)`, so the two Phase 9 keys reach the paid plans without a seed change,
 * and a أساسي tenant already pinned to `diwan` is unaffected.
 */
export function assertAllowedTemplate(templateKey: string, allowed: readonly string[]): void {
  if (!allowed.includes(templateKey)) {
    throw new Error(`Template ${templateKey} is not in templates_allowed for this tenant.`);
  }
}
