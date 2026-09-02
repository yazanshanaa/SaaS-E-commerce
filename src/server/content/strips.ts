import { z } from 'zod';
import {
  homeStripSchema,
  isWithinSchedule,
  stripColorSchema,
  STRIP_COLORS,
  type StripColor,
} from '@/shared/site-contract';
import type { ScopedDb, TenantTx } from '@/server/db';

/**
 * The two text strips: the site-wide announcement bar, and the mid-homepage strip Phase 9 adds.
 *
 * COLOUR IS A CLOSED SET OF FOUR, resolving through the ACTIVE TEMPLATE's tokens. The reference
 * shop's reasoning is right and the schema records it: a free colour picker on a strip that spans
 * every page is how a merchant breaks their own site. What is worth stating HERE is the second
 * half — why four token pairs and not four hex values.
 *
 * Every pair below is WCAG AA by construction, and none of it is luck:
 *
 *   primary   `--t-primary` / `--t-on-primary`     `readableOn()` picks black or white against the
 *   secondary `--t-secondary` / `--t-on-secondary` fill, and its docblock proves the worst-case
 *                                                  floor is 4.58:1;
 *   dark      `--t-text` / `--t-bg`                contrast is symmetric, and `deriveColorTokens`
 *                                                  guards `text` against `background` at 4.5:1 —
 *                                                  so the inverted pair clears the same bar;
 *   light     `--t-surface-alt` / `--t-text`       `text` is guarded against surface-alt by the
 *                                                  same call, over all three surfaces at once.
 *
 * So the strip cannot be made unreadable by any palette that `resolveColors` accepted, which is the
 * property a hex field could not have offered at any price. Nothing here emits a colour literal —
 * only `var(--t-*)` references, resolved by the shell's inline token block.
 */

export interface StripStyle {
  background: string;
  color: string;
}

const STRIP_STYLES: Record<StripColor, StripStyle> = {
  dark: { background: 'var(--t-text)', color: 'var(--t-bg)' },
  primary: { background: 'var(--t-primary)', color: 'var(--t-on-primary)' },
  secondary: { background: 'var(--t-secondary)', color: 'var(--t-on-secondary)' },
  light: { background: 'var(--t-surface-alt)', color: 'var(--t-text)' },
};

/** An unknown stored value falls back to `dark`, which every template can carry. */
export function stripStyle(color: string | null | undefined): StripStyle {
  const parsed = stripColorSchema.safeParse(color);
  return STRIP_STYLES[parsed.success ? parsed.data : 'dark'];
}

export { STRIP_COLORS };
export type { StripColor };

// -----------------------------------------------------------------------------
// The mid-homepage strip
// -----------------------------------------------------------------------------

/**
 * The stored shape, and what the storefront renders.
 *
 * `homeStripSchema` in `src/shared/site-contract` is the validator and is NOT redefined here — the
 * 160-character cap in particular is a decision with a reason attached (200 characters of Arabic
 * wraps to four lines on a 360px viewport) and two copies of it would eventually be two numbers.
 */
export interface HomeStripRow {
  enabled: boolean;
  text: string | null;
  link: string | null;
  startsAt: Date | null;
  endsAt: Date | null;
  color: StripColor;
}

export interface StripView {
  text: string;
  link: string | null;
  color: StripColor;
  style: StripStyle;
}

export async function loadHomeStrip(db: ScopedDb, tenantId: string): Promise<HomeStripRow | null> {
  const site = await db.site.findUnique({
    where: { tenantId },
    select: {
      homeStripEnabled: true,
      homeStripText: true,
      homeStripLink: true,
      homeStripStartsAt: true,
      homeStripEndsAt: true,
      homeStripColor: true,
    },
  });
  if (!site) return null;

  return {
    enabled: site.homeStripEnabled,
    text: site.homeStripText,
    link: site.homeStripLink,
    startsAt: site.homeStripStartsAt,
    endsAt: site.homeStripEndsAt,
    color: site.homeStripColor as StripColor,
  };
}

/**
 * Stored row + a clock -> what to render, or nothing.
 *
 * `now` is a parameter, never `new Date()` inside. The storefront's content read is cached for five
 * minutes and Next serves a stale entry while it revalidates, so a schedule decided at BUILD time
 * keeps an expired strip on the page for longer than the TTL suggests — the exact bug
 * `src/app/site/_data/context.ts` documents for the announcement bar and the offer cards.
 */
export function resolveStrip(row: HomeStripRow | null, now: Date): StripView | null {
  if (!row?.enabled) return null;

  const text = row.text?.trim();
  if (!text) return null;

  if (!isWithinSchedule(now, row.startsAt, row.endsAt)) return null;

  return {
    text,
    link: row.link?.trim() || null,
    color: row.color,
    style: stripStyle(row.color),
  };
}

export async function saveHomeStrip(
  tx: TenantTx,
  tenantId: string,
  input: z.infer<typeof homeStripSchema>,
): Promise<void> {
  await tx.site.update({
    where: { tenantId },
    data: {
      homeStripEnabled: input.enabled,
      /**
       * `|| null`, not `?? null`. The shared schema's `text` and `link` are `.trim().optional()`, so a
       * cleared field arrives as `''` rather than as `undefined` — and `?? null` would store the empty
       * string. Nothing breaks immediately (`resolveStrip` treats both as absent) but the column then
       * disagrees with `announcementBarText`, which the settings screen has always written as null, and
       * the next person to write `WHERE home_strip_text IS NOT NULL` gets a wrong count.
       */
      homeStripText: input.text || null,
      homeStripLink: input.link || null,
      homeStripStartsAt: input.startsAt ?? null,
      homeStripEndsAt: input.endsAt ?? null,
      homeStripColor: input.color,
    },
  });
}

// -----------------------------------------------------------------------------
// The announcement bar's new colour column
// -----------------------------------------------------------------------------

/**
 * ONLY the colour, and that is deliberate.
 *
 * The bar's text, link and schedule already have a writer — `saveAnnouncementBar` in
 * `src/app/dashboard/_lib/site.ts`, reached from the settings screen — and a second form writing
 * the same five columns is how a field gets blanked by a form that did not render it. Phase 9 added
 * exactly one column here (`announcement_bar_color`) and it had no writer at all, so that is exactly
 * what this touches. The consolidation, and the 160-vs-200 cap discrepancy it would fix, is written
 * out in `docs/PHASE-9-track-b-handoff.md`.
 */
export const announcementBarColorSchema = z.object({ color: stripColorSchema });

export async function saveAnnouncementBarColor(
  tx: TenantTx,
  tenantId: string,
  color: StripColor,
): Promise<void> {
  await tx.site.update({ where: { tenantId }, data: { announcementBarColor: color } });
}

export async function loadAnnouncementBarColor(
  db: ScopedDb,
  tenantId: string,
): Promise<StripColor> {
  const site = await db.site.findUnique({
    where: { tenantId },
    select: { announcementBarColor: true },
  });

  const parsed = stripColorSchema.safeParse(site?.announcementBarColor);
  return parsed.success ? parsed.data : 'dark';
}
