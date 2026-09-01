import { z } from 'zod';
import { can, canEdit } from '@/server/entitlements';
import {
  COLOR_PRESETS,
  TEMPLATES,
  TEMPLATE_KEYS,
  colorSelectionSchema,
  findPreset,
  isTemplateKey,
  resolveColors,
  type ColorMode,
  type ColorResolution,
  type ColorSelection,
  type TemplateDescriptor,
  type TemplateKey,
} from '@/shared/site-contract';
import type { MerchantContext } from './context';
import { audit, refreshStorefront } from './audit';
import { failure, invalid, type ActionState } from './validation';

/**
 * Appearance: the template, and the colours.
 *
 * The two are gated differently ON PURPOSE, and the difference is not an oversight:
 *
 *   - the TEMPLATE is not one of the six managed capabilities. It is constrained instead by the
 *     `templates_allowed` entitlement, which carries exactly one key on أساسي (set per tenant at
 *     onboarding) and all three above it. So a basic merchant sees their one template and no
 *     picker, without any capability being involved;
 *   - COLOURS are a managed capability AND a feature. `canEdit(colors)` decides whether the
 *     merchant may write at all, and `color_mode` — which lives on the availability axis —
 *     decides whether they get the five vetted sets or the free picker.
 *
 * The contrast guard runs in BOTH modes. The presets already clear AA by construction; the
 * guard still runs over them because a template may compose a pair their author did not
 * anticipate, and shipping an inaccessible storefront is a compliance failure (IS 5568), not a
 * taste one.
 */

export interface TemplateChoice extends TemplateDescriptor {
  current: boolean;
  /**
   * Whether `templates_allowed` actually permits this key.
   *
   * `false` renders a LOCKED card — visible, described, previewed, not selectable — instead of
   * omitting the template from the list. A أساسي merchant used to be shown a `<fieldset disabled>`
   * containing exactly one option, which reads as a broken screen rather than as a plan boundary:
   * there is nothing to compare, nothing to want, and no reason given. A locked card states the
   * boundary and shows what is behind it, which is the difference between a picker that explains
   * an upsell and one that just refuses.
   */
  available: boolean;
}

export interface AppearanceView {
  templateKey: string;
  /**
   * ALL nine templates, each flagged `available`. Not just the permitted ones — see
   * `TemplateChoice.available`. The server still refuses a locked key on submit; this list is
   * what the merchant is allowed to SEE, which is a different question from what they may pick.
   */
  templates: TemplateChoice[];
  /** True when the plan permits exactly one — the rest of the grid renders locked. */
  singleTemplate: boolean;
  colorMode: ColorMode;
  colorsEditable: boolean;
  presetKey: string | null;
  colors: {
    primary: string;
    secondary: string;
    background: string;
    surface: string | null;
    text: string | null;
  };
}

const FALLBACK_COLORS = {
  primary: TEMPLATES.diwan.defaults.primary,
  secondary: TEMPLATES.diwan.defaults.secondary,
  background: TEMPLATES.diwan.defaults.background,
  surface: null,
  text: null,
};

export async function allowedTemplateKeys(ctx: MerchantContext): Promise<TemplateKey[]> {
  const allowed = await can(ctx.tenantId, 'templates_allowed');
  const keys = Array.isArray(allowed) ? allowed : [];
  return keys.filter(isTemplateKey);
}

export async function loadAppearance(ctx: MerchantContext): Promise<AppearanceView | null> {
  const site = await ctx.db.site.findUnique({
    where: { tenantId: ctx.tenantId },
    select: { templateKey: true },
  });
  if (!site) return null;

  const [theme, allowed, mode, colorsEditable] = await Promise.all([
    ctx.db.themeSettings.findUnique({
      where: { tenantId: ctx.tenantId },
      select: {
        colorMode: true,
        presetKey: true,
        primary: true,
        secondary: true,
        background: true,
        surface: true,
        text: true,
      },
    }),
    allowedTemplateKeys(ctx),
    can(ctx.tenantId, 'color_mode'),
    canEdit(ctx.tenantId, ctx.role, 'colors'),
  ]);

  /**
   * The CURRENT template is always in the list, even if the entitlement no longer names it.
   *
   * A plan downgrade or a per-tenant override can leave a shop running a template it may not
   * newly choose. Omitting it would render a picker with nothing selected and let the first
   * click silently re-skin a live storefront.
   */
  const selectable = new Set<TemplateKey>(allowed);
  // The CURRENT template is always selectable, even if the entitlement no longer names it.
  if (isTemplateKey(site.templateKey)) selectable.add(site.templateKey);

  return {
    templateKey: site.templateKey,
    /*
     * The whole catalogue, in contract order, flagged rather than filtered.
     *
     * `TEMPLATE_KEYS` order is append-only and is the picker order on three surfaces, so mapping
     * over it directly keeps a merchant's cards from moving under their cursor after a deploy.
     */
    templates: TEMPLATE_KEYS.map((key) => ({
      ...TEMPLATES[key],
      current: key === site.templateKey,
      available: selectable.has(key),
    })),
    singleTemplate: allowed.length <= 1,
    colorMode: mode === 'custom' ? 'custom' : 'preset',
    colorsEditable,
    presetKey: theme?.presetKey ?? null,
    colors: theme
      ? {
          primary: theme.primary,
          secondary: theme.secondary,
          background: theme.background,
          surface: theme.surface,
          text: theme.text,
        }
      : FALLBACK_COLORS,
  };
}

// -----------------------------------------------------------------------------
// Template
// -----------------------------------------------------------------------------

export const templateSchema = z.object({ templateKey: z.string().trim().min(1) });

export async function saveTemplate(ctx: MerchantContext, raw: unknown): Promise<ActionState | null> {
  const parsed = templateSchema.safeParse(raw);
  if (!parsed.success) return invalid(parsed.error);

  const allowed = await allowedTemplateKeys(ctx);
  const next = parsed.data.templateKey;

  // Server-side, always. The picker now renders the WHOLE catalogue — locked cards included, so
  // a merchant can see what the next plan buys — which makes this check the only thing standing
  // between a hand-posted form and a free upgrade. A form is a hint; a plan is a boundary.
  if (!isTemplateKey(next) || !allowed.includes(next)) {
    return failure('dashboard:errors.templateNotAllowed');
  }

  const before = await ctx.db.site.findUnique({
    where: { tenantId: ctx.tenantId },
    select: { templateKey: true },
  });
  if (!before) return failure('dashboard:errors.notFound');
  if (before.templateKey === next) return null;

  await ctx.db.site.update({ where: { tenantId: ctx.tenantId }, data: { templateKey: next } });

  await audit(ctx, {
    action: 'site.template_changed',
    entityType: 'site',
    before: { templateKey: before.templateKey },
    after: { templateKey: next },
  });

  await refreshStorefront(ctx.tenantId);
  return null;
}

// -----------------------------------------------------------------------------
// Colours
// -----------------------------------------------------------------------------

export interface SaveColorsResult {
  state: ActionState | null;
  /** What the AA guard had to move, so the UI can SAY so rather than change it silently. */
  resolution?: ColorResolution;
}

export async function saveColors(ctx: MerchantContext, raw: unknown): Promise<SaveColorsResult> {
  if (!(await canEdit(ctx.tenantId, ctx.role, 'colors'))) {
    return { state: failure('dashboard:errors.capabilityLocked') };
  }

  const parsed = colorSelectionSchema.safeParse(raw);
  if (!parsed.success) return { state: invalid(parsed.error) };

  const selection = parsed.data;
  const mode = await can(ctx.tenantId, 'color_mode');

  // A merchant on `preset` submitting free hex values is asking for something their plan does
  // not include. A1 refuses the same shape when applying a change request, for the same reason.
  if (selection.mode === 'custom' && mode !== 'custom') {
    return { state: failure('dashboard:errors.colorMode') };
  }

  const resolution = resolveColors(selection);
  const { colors } = resolution;

  await ctx.db.themeSettings.upsert({
    where: { tenantId: ctx.tenantId },
    create: {
      tenantId: ctx.tenantId,
      colorMode: selection.mode,
      presetKey: selection.mode === 'preset' ? selection.presetKey : null,
      ...colors,
    },
    update: {
      colorMode: selection.mode,
      presetKey: selection.mode === 'preset' ? selection.presetKey : null,
      ...colors,
    },
  });

  await audit(ctx, {
    action: 'site.colors_changed',
    entityType: 'theme_settings',
    after: {
      mode: selection.mode,
      ...colors,
      contrastAdjustments: resolution.adjustments,
    },
  });

  await refreshStorefront(ctx.tenantId);
  return { state: null, resolution };
}

/** Read a colour selection out of a submitted form, in the mode the tenant is actually in. */
export function colorSelectionFromForm(
  mode: ColorMode,
  read: (name: string) => string,
): ColorSelection | { presetKey: string; mode: 'preset' } {
  if (mode === 'preset') {
    return { mode: 'preset', presetKey: read('presetKey') };
  }

  return {
    mode: 'custom',
    primary: read('primary'),
    secondary: read('secondary'),
    background: read('background'),
    surface: read('surface') || undefined,
    text: read('text') || undefined,
  } as ColorSelection;
}

export { COLOR_PRESETS, findPreset };
export type { ColorMode, ColorResolution, ColorSelection, TemplateKey };
