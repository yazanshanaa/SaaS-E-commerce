import { z } from 'zod';
import { can, canEdit } from '@/server/entitlements';
import {
  COLOR_PRESETS,
  TEMPLATES,
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
}

export interface AppearanceView {
  templateKey: string;
  /** Only the templates this tenant's entitlement actually permits. */
  templates: TemplateChoice[];
  /** True when the plan permits exactly one — the picker becomes a statement of fact. */
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
  const keys = allowed.includes(site.templateKey as TemplateKey)
    ? allowed
    : [...allowed, ...(isTemplateKey(site.templateKey) ? [site.templateKey] : [])];

  return {
    templateKey: site.templateKey,
    templates: keys.map((key) => ({ ...TEMPLATES[key], current: key === site.templateKey })),
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

  // Server-side, always. The picker only renders permitted templates, but a form is a hint and
  // a plan is a boundary — accepting an unlisted key here would hand out an upgrade for free.
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
