import { canBool, canEdit } from '@/server/entitlements';
import { withTenantTxn } from '@/server/db';
import {
  MAX_STORE_STATS,
  MAX_TRUST_BADGES,
  STRIP_COLORS,
  TRUST_ICON_KEYS,
  WEEKDAYS,
  announcementBarColorSchema,
  deleteStoreStat,
  deleteTrustBadge,
  listStoreStats,
  listTrustBadges,
  loadAnnouncementBarColor,
  loadHomeStrip,
  loadOpeningHours,
  openingHoursPayloadFrom,
  openingHoursSchema,
  saveAnnouncementBarColor,
  saveHomeStrip,
  saveOpeningHours,
  saveStoreStat,
  saveTrustBadge,
  storeStatInputSchema,
  storeStatsPayloadFrom,
  trustBadgeInputSchema,
  trustBadgesPayloadFrom,
  type HomeStripRow,
  type OpeningHoursView,
  type StoreStatRow,
  type StripColor,
  type TrustBadgeRow,
} from '@/server/content';
import { homeStripSchema } from '@/shared/site-contract';
import { t } from '@/shared/i18n';
import type { CapabilityKey } from '@/shared/features';
import type { MerchantContext } from './context';
import { audit, auditInTx, refreshStorefront } from './audit';
import { failure, invalid, parseJerusalemInput, type ActionState, type FieldError } from './validation';

/**
 * The homepage extras: the trust row, the opening-hours table, the store stats, and the two text
 * strips.
 *
 * ONE FEATURE, THREE CAPABILITIES. `homepage_extras` is deliberately a single key — its docblock in
 * `src/shared/features.ts` says why: the three are one "make the homepage feel like a real shop"
 * decision, and three keys would be three screens an admin has to remember to turn on together.
 * Their EDIT permissions stay three separate capabilities (`trust_badges`, `opening_hours`,
 * `store_stats`), which is the axis where the distinction actually matters — a platform may want to
 * write a shop's hours without touching its trust claims.
 *
 * THE TWO STRIPS ARE NOT UNDER `homepage_extras`, and that is not an omission. There is no feature key
 * for either in `src/shared/features.ts`: the announcement bar has been a base capability since Phase
 * 1, and Phase 9 added the second strip as a column set beside it rather than as a new product
 * feature. Inventing a key here would put a gate in the UI that nothing on the admin side can open —
 * the same reasoning Track A recorded for `compareAtPriceAgorot`. Both strips answer to the
 * `announcement_bar` capability, because they are the same thing in two places.
 */

// -----------------------------------------------------------------------------
// Reading
// -----------------------------------------------------------------------------

export interface HomepageExtrasView {
  badges: TrustBadgeRow[];
  hours: OpeningHoursView;
  stats: StoreStatRow[];
  iconKeys: readonly string[];
  maxBadges: number;
  maxStats: number;
  badgeCapReached: boolean;
  statCapReached: boolean;
}

/** Null when the plan does not include `homepage_extras` — the routes turn that into a 404. */
export async function loadHomepageExtras(
  ctx: MerchantContext,
): Promise<HomepageExtrasView | null> {
  if (!(await canBool(ctx.tenantId, 'homepage_extras'))) return null;

  const [badges, hours, stats] = await Promise.all([
    listTrustBadges(ctx.db, ctx.tenantId),
    loadOpeningHours(ctx.db, ctx.tenantId),
    listStoreStats(ctx.db, ctx.tenantId),
  ]);

  return {
    badges,
    hours,
    stats,
    iconKeys: TRUST_ICON_KEYS,
    maxBadges: MAX_TRUST_BADGES,
    maxStats: MAX_STORE_STATS,
    badgeCapReached: badges.length >= MAX_TRUST_BADGES,
    statCapReached: stats.length >= MAX_STORE_STATS,
  };
}

export interface StripsView {
  /** The bar's new colour column. Its text and schedule stay on the settings screen — see below. */
  barColor: StripColor;
  /** Read-only here, so the colour picker is not a colour picker for a bar nobody can see. */
  barEnabled: boolean;
  barText: string | null;
  homeStrip: HomeStripRow;
  colors: readonly StripColor[];
}

export async function loadStrips(ctx: MerchantContext): Promise<StripsView | null> {
  const [barColor, homeStrip, site] = await Promise.all([
    loadAnnouncementBarColor(ctx.db, ctx.tenantId),
    loadHomeStrip(ctx.db, ctx.tenantId),
    ctx.db.site.findUnique({
      where: { tenantId: ctx.tenantId },
      select: { announcementBarEnabled: true, announcementBarText: true },
    }),
  ]);

  if (!homeStrip || !site) return null;

  return {
    barColor,
    barEnabled: site.announcementBarEnabled,
    barText: site.announcementBarText,
    homeStrip,
    colors: STRIP_COLORS,
  };
}

// -----------------------------------------------------------------------------
// Shared gating
// -----------------------------------------------------------------------------

function contentField(field: string, key: string, params?: Record<string, string | number>): FieldError {
  return { field, messageKey: `content:${key}`, message: t('content', key, params) };
}

/**
 * Both axes, in this order, for every write below.
 *
 * Feature first: a plan without `homepage_extras` has no such content at all, so a locked-capability
 * message would be answering a question the merchant never asked. Then `canEdit` — re-checked here
 * and not only in the action, because the action decides which DESTINATION a submit goes to and a
 * stale tab must not be able to write through the direct path.
 */
async function assertExtraWritable(
  ctx: MerchantContext,
  capabilityKey: CapabilityKey,
): Promise<ActionState | null> {
  if (!(await canBool(ctx.tenantId, 'homepage_extras'))) return failure('dashboard:errors.forbidden');
  if (!(await canEdit(ctx.tenantId, ctx.role, capabilityKey))) {
    return failure('dashboard:errors.capabilityLocked');
  }
  return null;
}

// -----------------------------------------------------------------------------
// Trust badges — capability `trust_badges`
// -----------------------------------------------------------------------------

export function trustBadgeFromForm(
  read: (name: string) => string,
  readBool: (name: string) => boolean,
): unknown {
  const sort = read('sort').trim();

  return {
    ...(read('badgeId').trim() ? { id: read('badgeId').trim() } : {}),
    icon: read('icon'),
    title: read('title'),
    subtitle: read('subtitle'),
    sort: sort === '' ? 0 : Number(sort),
    published: readBool('published'),
  };
}

export async function saveTrustBadgeForMerchant(
  ctx: MerchantContext,
  raw: unknown,
): Promise<ActionState | null> {
  const locked = await assertExtraWritable(ctx, 'trust_badges');
  if (locked) return locked;

  const parsed = trustBadgeInputSchema.safeParse(raw);
  if (!parsed.success) return invalid(parsed.error);

  const state = await withTenantTxn(
    ctx.tenantId,
    async (tx): Promise<ActionState | null> => {
      const result = await saveTrustBadge(tx, ctx.tenantId, parsed.data);
      if (result.ok) return null;

      return result.error === 'cap_reached'
        ? failure('dashboard:errors.validation', [
            contentField('_form', 'errors.badgeCapReached', { max: MAX_TRUST_BADGES }),
          ])
        : failure('dashboard:errors.notFound');
    },
    { actor: ctx.actor },
  );

  if (!state) await refreshStorefront(ctx.tenantId);
  return state;
}

export async function deleteTrustBadgeForMerchant(
  ctx: MerchantContext,
  badgeId: string,
): Promise<ActionState | null> {
  const locked = await assertExtraWritable(ctx, 'trust_badges');
  if (locked) return locked;

  const state = await withTenantTxn(
    ctx.tenantId,
    async (tx): Promise<ActionState | null> => {
      const before = await deleteTrustBadge(tx, ctx.tenantId, badgeId);
      if (!before) return failure('dashboard:errors.notFound');

      await auditInTx(tx, ctx, {
        action: 'trust_badge.deleted',
        entityType: 'trust_badge',
        entityId: badgeId,
        before: { icon: before.icon, title: before.title },
      });
      return null;
    },
    { actor: ctx.actor },
  );

  if (!state) await refreshStorefront(ctx.tenantId);
  return state;
}

// -----------------------------------------------------------------------------
// Opening hours — capability `opening_hours`
// -----------------------------------------------------------------------------

/**
 * Seven days, read from INDEXED field names rather than parallel repeated ones.
 *
 * `sizeGuideFromForm` zips two repeated lists by index and that works because both of its fields are
 * text inputs. It would break here: **an unchecked checkbox sends nothing at all**, so a week with
 * Friday closed would post six `closed` values for seven days and every row after Friday would read
 * the wrong day's flag. Indexing the names removes the alignment problem instead of documenting it.
 */
export function openingHoursFromForm(
  read: (name: string) => string,
  readBool: (name: string) => boolean,
): unknown {
  return {
    days: WEEKDAYS.map((weekday) => ({
      weekday,
      closed: readBool(`closed-${weekday}`),
      opensAt: read(`opensAt-${weekday}`),
      closesAt: read(`closesAt-${weekday}`),
    })),
    note: read('note'),
  };
}

export async function saveOpeningHoursForMerchant(
  ctx: MerchantContext,
  raw: unknown,
): Promise<ActionState | null> {
  const locked = await assertExtraWritable(ctx, 'opening_hours');
  if (locked) return locked;

  const parsed = openingHoursSchema.safeParse(raw);
  if (!parsed.success) return invalid(parsed.error);

  await withTenantTxn(ctx.tenantId, (tx) => saveOpeningHours(tx, ctx.tenantId, parsed.data), {
    actor: ctx.actor,
  });

  await refreshStorefront(ctx.tenantId);
  return null;
}

// -----------------------------------------------------------------------------
// Store stats — capability `store_stats`
// -----------------------------------------------------------------------------

/**
 * `value` is read as TEXT and stays text — no `Number()` anywhere on this path.
 *
 * The figures a shop is proud of are "7+", "4000+" and "100%". Coercing them would render «7» and
 * lose the plus, which is the model docblock's own reason for the column being a `String`.
 */
export function storeStatFromForm(
  read: (name: string) => string,
  readBool: (name: string) => boolean,
): unknown {
  const sort = read('sort').trim();

  return {
    ...(read('statId').trim() ? { id: read('statId').trim() } : {}),
    value: read('value'),
    label: read('label'),
    sort: sort === '' ? 0 : Number(sort),
    published: readBool('published'),
  };
}

export async function saveStoreStatForMerchant(
  ctx: MerchantContext,
  raw: unknown,
): Promise<ActionState | null> {
  const locked = await assertExtraWritable(ctx, 'store_stats');
  if (locked) return locked;

  const parsed = storeStatInputSchema.safeParse(raw);
  if (!parsed.success) return invalid(parsed.error);

  const state = await withTenantTxn(
    ctx.tenantId,
    async (tx): Promise<ActionState | null> => {
      const result = await saveStoreStat(tx, ctx.tenantId, parsed.data);
      if (result.ok) return null;

      return result.error === 'cap_reached'
        ? failure('dashboard:errors.validation', [
            contentField('_form', 'errors.statCapReached', { max: MAX_STORE_STATS }),
          ])
        : failure('dashboard:errors.notFound');
    },
    { actor: ctx.actor },
  );

  if (!state) await refreshStorefront(ctx.tenantId);
  return state;
}

export async function deleteStoreStatForMerchant(
  ctx: MerchantContext,
  statId: string,
): Promise<ActionState | null> {
  const locked = await assertExtraWritable(ctx, 'store_stats');
  if (locked) return locked;

  const state = await withTenantTxn(
    ctx.tenantId,
    async (tx): Promise<ActionState | null> => {
      const before = await deleteStoreStat(tx, ctx.tenantId, statId);
      if (!before) return failure('dashboard:errors.notFound');

      await auditInTx(tx, ctx, {
        action: 'store_stat.deleted',
        entityType: 'store_stat',
        entityId: statId,
        before: { value: before.value, label: before.label },
      });
      return null;
    },
    { actor: ctx.actor },
  );

  if (!state) await refreshStorefront(ctx.tenantId);
  return state;
}

// -----------------------------------------------------------------------------
// The two strips — capability `announcement_bar`
// -----------------------------------------------------------------------------

/**
 * The shared schema, with the two refinements a FORM needs and a stored shape does not.
 *
 * `homeStripSchema` is imported, never re-declared: the 160-character cap is a decision with a reason
 * attached (200 characters of Arabic wraps to four lines on a 360px viewport) and a second copy of it
 * would eventually be a second number. What is added here is the pair of cross-field rules — enabled
 * without text renders NOTHING, silently, which is indistinguishable from broken; and an end before a
 * start is a window that can never open.
 */
const homeStripFormSchema = homeStripSchema
  .refine((value) => !value.enabled || Boolean(value.text && value.text.trim() !== ''), {
    message: 'dashboard:errors.required',
    path: ['text'],
  })
  .refine((value) => !value.startsAt || !value.endsAt || value.startsAt <= value.endsAt, {
    message: 'dashboard:errors.invalidDate',
    path: ['endsAt'],
  });

/**
 * The key is OMITTED for an empty date, never sent as `''`.
 *
 * `homeStripSchema` uses `z.coerce.date()`, and `new Date('')` is an Invalid Date that zod rejects —
 * so a blank optional date would surface as a validation error on a field the merchant deliberately did
 * not fill in. A value that IS present goes through `parseJerusalemInput`, so `2026-08-31` means
 * midnight in Bartaa rather than three hours earlier; and a MALFORMED one is passed through as the raw
 * string so `z.coerce.date()` refuses it, rather than being collapsed into "no date" and silently
 * clearing the merchant's schedule.
 */
export function homeStripFromForm(
  read: (name: string) => string,
  readBool: (name: string) => boolean,
): unknown {
  const startsAt = read('startsAt').trim();
  const endsAt = read('endsAt').trim();

  return {
    enabled: readBool('enabled'),
    text: read('text'),
    link: read('link'),
    ...(startsAt === '' ? {} : { startsAt: parseJerusalemInput(startsAt) ?? startsAt }),
    ...(endsAt === '' ? {} : { endsAt: parseJerusalemInput(endsAt) ?? endsAt }),
    color: read('color'),
  };
}

export async function saveHomeStripForMerchant(
  ctx: MerchantContext,
  raw: unknown,
): Promise<ActionState | null> {
  if (!(await canEdit(ctx.tenantId, ctx.role, 'announcement_bar'))) {
    return failure('dashboard:errors.capabilityLocked');
  }

  const parsed = homeStripFormSchema.safeParse(raw);
  if (!parsed.success) return invalid(parsed.error);

  await withTenantTxn(ctx.tenantId, (tx) => saveHomeStrip(tx, ctx.tenantId, parsed.data), {
    actor: ctx.actor,
  });

  await refreshStorefront(ctx.tenantId);
  return null;
}

export async function saveBarColorForMerchant(
  ctx: MerchantContext,
  raw: unknown,
): Promise<ActionState | null> {
  if (!(await canEdit(ctx.tenantId, ctx.role, 'announcement_bar'))) {
    return failure('dashboard:errors.capabilityLocked');
  }

  const parsed = announcementBarColorSchema.safeParse(raw);
  if (!parsed.success) return invalid(parsed.error);

  await withTenantTxn(
    ctx.tenantId,
    (tx) => saveAnnouncementBarColor(tx, ctx.tenantId, parsed.data.color),
    { actor: ctx.actor },
  );

  /**
   * Audited, and it is the one strip write that is.
   *
   * The bar is on EVERY page of the shop, and its colour is the one field on this screen a merchant
   * can change without changing a single word — so «الشريط صار لونه غلط ومش أنا» is a support call
   * with nothing else to look at.
   */
  await audit(ctx, {
    action: 'site.announcement_bar_color_changed',
    entityType: 'site',
    after: { announcementBarColor: parsed.data.color },
  });

  await refreshStorefront(ctx.tenantId);
  return null;
}

// -----------------------------------------------------------------------------
// Change-request payloads
// -----------------------------------------------------------------------------

/**
 * The whole row / week / set, with the edit merged in — same reasoning as `bannerRequestPayload`: a
 * request naming one item by id is a request an operator cannot apply once the merchant has tidied up.
 */
export function trustBadgesRequestPayload(stored: TrustBadgeRow[], edited: unknown): unknown {
  const parsed = trustBadgeInputSchema.safeParse(edited);
  if (!parsed.success) return trustBadgesPayloadFrom(stored);

  const draft: TrustBadgeRow = {
    id: parsed.data.id ?? '',
    icon: parsed.data.icon,
    title: parsed.data.title,
    subtitle: parsed.data.subtitle,
    sort: parsed.data.sort,
    published: parsed.data.published,
  };

  const merged = parsed.data.id
    ? stored.map((row) => (row.id === parsed.data.id ? draft : row))
    : [...stored, draft].slice(0, MAX_TRUST_BADGES);

  return trustBadgesPayloadFrom(merged);
}

export function storeStatsRequestPayload(stored: StoreStatRow[], edited: unknown): unknown {
  const parsed = storeStatInputSchema.safeParse(edited);
  if (!parsed.success) return storeStatsPayloadFrom(stored);

  const draft: StoreStatRow = {
    id: parsed.data.id ?? '',
    value: parsed.data.value,
    label: parsed.data.label,
    sort: parsed.data.sort,
    published: parsed.data.published,
  };

  const merged = parsed.data.id
    ? stored.map((row) => (row.id === parsed.data.id ? draft : row))
    : [...stored, draft].slice(0, MAX_STORE_STATS);

  return storeStatsPayloadFrom(merged);
}

export function openingHoursRequestPayload(edited: unknown, fallback: OpeningHoursView): unknown {
  const parsed = openingHoursSchema.safeParse(edited);
  if (!parsed.success) return openingHoursPayloadFrom(fallback);

  return {
    days: parsed.data.days.map((day) => ({
      weekday: day.weekday,
      closed: day.closed,
      opensAt: day.closed ? null : day.opensAt,
      closesAt: day.closed ? null : day.closesAt,
    })),
    note: parsed.data.note,
  };
}

export { MAX_STORE_STATS, MAX_TRUST_BADGES, TRUST_ICON_KEYS, WEEKDAYS };
export type { OpeningHoursView, StoreStatRow, StripColor, TrustBadgeRow };
