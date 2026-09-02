import { canBool, canEdit } from '@/server/entitlements';
import { withTenantTxn } from '@/server/db';
import {
  MAX_BANNERS,
  bannerInputSchema,
  bannersPayloadFrom,
  deleteBanner,
  listBanners,
  saveBanner,
  type BannerRow,
} from '@/server/content';
import { t } from '@/shared/i18n';
import type { MediaPickerItem } from '../_components/media-picker';
import { loadMediaChoices } from './branding';
import type { MerchantContext } from './context';
import { auditInTx, refreshStorefront } from './audit';
import { failure, invalid, parseJerusalemInput, type ActionState, type FieldError } from './validation';

/**
 * The banner board on the merchant's side — the `banners_slider` feature and the `banners`
 * capability.
 *
 * `editable_by: admin` is a real choice for this one and the capability's docblock says why: a banner
 * is the single most visible thing on the homepage and the platform may reasonably want to design it.
 * So the locked path is not an afterthought here — it is the intended state on some plans, and it
 * still RENDERS on the storefront.
 *
 * ONE FORM PER BANNER, not one form for the board. A banner carries an image, a headline, a subtitle,
 * a CTA and a schedule; six of those in one submit is a form nobody can review before pressing save,
 * and a validation failure on banner four would throw away the merchant's edits to one, two and
 * three. The board-shaped payload the change request carries is assembled from the STORED rows plus
 * the one being edited — see `bannerRequestPayload`.
 */

export interface BannerEditorView {
  banners: BannerRow[];
  choices: MediaPickerItem[];
  /** True when the board is full, so the screen can say so instead of failing the save. */
  capReached: boolean;
  maxBanners: number;
}

/** Null when the plan does not include `banners_slider` — the route turns that into a 404. */
export async function loadBannerEditor(ctx: MerchantContext): Promise<BannerEditorView | null> {
  if (!(await canBool(ctx.tenantId, 'banners_slider'))) return null;

  const [banners, choices] = await Promise.all([
    listBanners(ctx.db, ctx.tenantId),
    loadMediaChoices(ctx),
  ]);

  return {
    banners,
    choices,
    capReached: banners.length >= MAX_BANNERS,
    maxBanners: MAX_BANNERS,
  };
}

/**
 * One banner, read off the form.
 *
 * `startsAt` / `endsAt` go through `parseJerusalemInput`, not `new Date(value)`. A date input sends
 * `2026-08-31` with no timezone and reading that as UTC moves a scheduled banner three hours earlier
 * than the person who typed it meant — which, on the last day of a month, is a different day
 * (`_lib/validation.ts` states the rule; this is the third surface to need it).
 */
export function bannerFromForm(read: (name: string) => string, readBool: (name: string) => boolean): unknown {
  const startsAt = read('startsAt').trim();
  const endsAt = read('endsAt').trim();
  const sort = read('sort').trim();

  return {
    ...(read('bannerId').trim() ? { id: read('bannerId').trim() } : {}),
    imageMediaId: read('imageMediaId'),
    alt: read('alt'),
    title: read('title'),
    subtitle: read('subtitle'),
    ctaLabel: read('ctaLabel'),
    ctaHref: read('ctaHref'),
    sort: sort === '' ? 0 : Number(sort),
    published: readBool('published'),
    /**
     * An UNPARSEABLE value is passed through, not turned into `null`.
     *
     * `parseJerusalemInput` returns null for both "empty" and "malformed", and collapsing the two here
     * would make a typo silently clear the merchant's schedule — the banner starts running today and
     * nobody is told. Handing the raw string to `z.date()` instead turns it into a validation error the
     * merchant reads. Reachable in practice: `type="date"` degrades to a text box in some browsers, and
     * a pasted value is not always what it looks like.
     */
    startsAt: startsAt === '' ? null : (parseJerusalemInput(startsAt) ?? startsAt),
    endsAt: endsAt === '' ? null : (parseJerusalemInput(endsAt) ?? endsAt),
  };
}

function contentField(field: string, key: string, params?: Record<string, string | number>): FieldError {
  return { field, messageKey: `content:${key}`, message: t('content', key, params) };
}

async function assertWritable(ctx: MerchantContext): Promise<ActionState | null> {
  if (!(await canBool(ctx.tenantId, 'banners_slider'))) return failure('dashboard:errors.forbidden');
  // Re-checked here rather than only in the action — see `saveBrandingForMerchant` for the stale-tab
  // reasoning this whole surface follows.
  if (!(await canEdit(ctx.tenantId, ctx.role, 'banners'))) {
    return failure('dashboard:errors.capabilityLocked');
  }
  return null;
}

export async function saveBannerForMerchant(
  ctx: MerchantContext,
  raw: unknown,
): Promise<ActionState | null> {
  const locked = await assertWritable(ctx);
  if (locked) return locked;

  const parsed = bannerInputSchema.safeParse(raw);
  if (!parsed.success) return invalid(parsed.error);

  const state = await withTenantTxn(
    ctx.tenantId,
    async (tx): Promise<ActionState | null> => {
      const result = await saveBanner(tx, ctx.tenantId, parsed.data);
      if (result.ok) return null;

      if (result.error === 'cap_reached') {
        /**
         * The cap arrives with ITS NUMBER IN IT, through the already-resolved-sentence escape hatch
         * `FieldError.message` documents. A key alone would render «لحد {max} بانر» literally, and
         * guessing the parameter in the form component would print a confident wrong number.
         */
        return failure('dashboard:errors.validation', [
          contentField('_form', 'errors.bannerCapReached', { max: MAX_BANNERS }),
        ]);
      }
      if (result.error === 'image_unusable') {
        return failure('dashboard:errors.validation', [
          contentField('imageMediaId', 'errors.bannerImageUnusable'),
        ]);
      }
      return failure('dashboard:errors.notFound');
    },
    { actor: ctx.actor },
  );

  if (!state) await refreshStorefront(ctx.tenantId);
  return state;
}

export async function deleteBannerForMerchant(
  ctx: MerchantContext,
  bannerId: string,
): Promise<ActionState | null> {
  const locked = await assertWritable(ctx);
  if (locked) return locked;

  const state = await withTenantTxn(
    ctx.tenantId,
    async (tx): Promise<ActionState | null> => {
      const before = await deleteBanner(tx, ctx.tenantId, bannerId);
      if (!before) return failure('dashboard:errors.notFound');

      // Destructive, so it is audited — the line `_lib/audit.ts` draws. A banner is content the
      // merchant wrote and there is no undo.
      await auditInTx(tx, ctx, {
        action: 'banner.deleted',
        entityType: 'banner',
        entityId: bannerId,
        before: { title: before.title, published: before.published, sort: before.sort },
      });

      return null;
    },
    { actor: ctx.actor },
  );

  if (!state) await refreshStorefront(ctx.tenantId);
  return state;
}

/**
 * The change-request payload for a locked board: every stored banner, with the edited one merged in.
 *
 * A request that named one banner by id would be unappliable a week later — the merchant may have
 * deleted the row, and «عدّل البانر الثاني» is not something a queue can resolve. So the operator
 * receives the board the merchant wants, whole, and applying it is a replace.
 */
export function bannerRequestPayload(stored: BannerRow[], edited: unknown): unknown {
  const parsed = bannerInputSchema.safeParse(edited);
  if (!parsed.success) return bannersPayloadFrom(stored);

  const input = parsed.data;
  const draft: BannerRow = {
    id: input.id ?? '',
    imageMediaId: input.imageMediaId,
    alt: input.alt,
    title: input.title,
    subtitle: input.subtitle,
    ctaLabel: input.ctaLabel,
    ctaHref: input.ctaHref,
    sort: input.sort,
    published: input.published,
    startsAt: input.startsAt,
    endsAt: input.endsAt,
  };

  const merged = input.id
    ? stored.map((row) => (row.id === input.id ? draft : row))
    : [...stored, draft].slice(0, MAX_BANNERS);

  return bannersPayloadFrom(merged);
}

export { MAX_BANNERS };
export type { BannerRow };
