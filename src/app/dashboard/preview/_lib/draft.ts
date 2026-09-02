import {
  colorSelectionSchema,
  isTemplateKey,
  PRESET_KEYS,
  resolveColors,
  type ColorSelection,
  type ResolvedColors,
} from '@/shared/site-contract';
import { getTemplate } from '@/templates';
import type { TemplateDefinition } from '@/templates/types';
import { loadAppearance, type AppearanceView } from '../../_lib/appearance';
import type { MerchantContext } from '../../_lib/context';

/**
 * The preview's draft state (Phase 11, Track 11.D): a template key plus a colour selection,
 * carried in the URL — colours are not personal data, and search params are what lets the
 * appearance screen re-render the iframe with nothing saved and nothing POSTed.
 *
 * EVERYTHING IS VALIDATED AGAINST WHAT THIS TENANT MAY ACTUALLY HAVE, and anything invalid falls
 * back to the SAVED appearance rather than erroring: a preview that 500s over a hand-edited URL
 * teaches a merchant the feature is fragile, while one that shows their real shop teaches them
 * nothing was lost. The same rules the save path enforces are enforced here —
 * `templates_allowed` for the key (plus the currently-saved key, which stays previewable even
 * when a downgrade removed it from the entitlement), and the tenant's `color_mode` for a custom
 * selection — so the preview can never show a plan a merchant does not have.
 */
export interface PreviewDraft {
  template: TemplateDefinition;
  colors: ResolvedColors;
  appearance: AppearanceView;
}

/** Accept `C2410C` or `#C2410C` — the studio strips the hash to keep the URL readable. */
function hexParam(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  return trimmed.startsWith('#') ? trimmed : `#${trimmed}`;
}

function savedSelection(appearance: AppearanceView): ColorSelection {
  if (appearance.colorMode === 'preset' && appearance.presetKey) {
    return { mode: 'preset', presetKey: appearance.presetKey };
  }

  const parsed = colorSelectionSchema.safeParse({
    mode: 'custom',
    primary: appearance.colors.primary,
    secondary: appearance.colors.secondary,
    background: appearance.colors.background,
    surface: appearance.colors.surface ?? undefined,
    text: appearance.colors.text ?? undefined,
  });

  // The stored row always parses; the fallback is for a tenant with no ThemeSettings at all,
  // whose `loadAppearance` colours are already the diwan defaults.
  return parsed.success
    ? parsed.data
    : { mode: 'preset', presetKey: PRESET_KEYS[0]! };
}

export async function resolvePreviewDraft(
  ctx: MerchantContext,
  params: Record<string, string | string[] | undefined>,
): Promise<PreviewDraft | null> {
  const appearance = await loadAppearance(ctx);
  if (!appearance) return null;

  const one = (name: string): string | undefined => {
    const value = params[name];
    if (Array.isArray(value)) return value[0];
    return value && value.length > 0 ? value : undefined;
  };

  // --- the template -----------------------------------------------------------------------
  const requested = one('template');
  const allowedKeys = appearance.templates.map((template) => template.key);
  const templateKey =
    requested && isTemplateKey(requested) && allowedKeys.includes(requested)
      ? requested
      : appearance.templateKey;

  // --- the colours ------------------------------------------------------------------------
  let selection = savedSelection(appearance);

  const mode = one('mode');
  if (mode === 'preset') {
    const presetKey = one('presetKey');
    if (presetKey && PRESET_KEYS.includes(presetKey)) {
      selection = { mode: 'preset', presetKey };
    }
  } else if (mode === 'custom' && appearance.colorMode === 'custom') {
    const parsed = colorSelectionSchema.safeParse({
      mode: 'custom',
      primary: hexParam(one('primary')),
      secondary: hexParam(one('secondary')),
      background: hexParam(one('background')),
      surface: hexParam(one('surface')),
      text: hexParam(one('text')),
    });
    if (parsed.success) selection = parsed.data;
  }

  // The SAME guard the save path runs — the preview shows exactly what saving would produce,
  // adjustments included, which is the honest half of "contrast before the save".
  const { colors } = resolveColors(selection);

  return { template: getTemplate(templateKey), colors, appearance };
}
