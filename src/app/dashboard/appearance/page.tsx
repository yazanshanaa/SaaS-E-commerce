import { t } from '@/shared/i18n';
import { loadAppearance } from '../_lib/appearance';
import { loadCapabilityContext } from '../_lib/change-requests';
import { requireMerchantPage } from '../_components/guard';
import { Empty, PageHead } from '../_components/ui';
import { AppearanceStudio } from './appearance-studio';
import './appearance.css';

/**
 * Template and colours — the appearance studio (Phase 11, Track 11.D).
 *
 * The two are gated differently, and the screen shows the difference rather than smoothing it
 * over. The TEMPLATE is limited by `templates_allowed` — one key on أساسي, so the picker becomes
 * a statement of fact rather than a choice. COLOURS are a managed capability: where
 * `editable_by = admin` the editor still renders, filled in and read-only, with the change
 * request attached to the same submit — so the merchant picks what they want and asks for it in
 * one gesture instead of describing a colour in a text box.
 *
 * WHAT PHASE 11 CHANGED: the `<select>` whose option label was the only thing a merchant ever
 * saw of a design became a card grid; the mock preview block became the LIVE preview — the
 * tenant's own storefront in a same-origin iframe (Q28/Q37), re-rendered from the unsaved draft;
 * and the contrast guard now speaks BEFORE the save, in the editor, instead of only in a success
 * message afterwards. The save path is untouched: the same two server actions, the same
 * server-side enforcement of `templates_allowed`, `color_mode` and `canEdit`.
 */
export const dynamic = 'force-dynamic';

export default async function AppearancePage() {
  const ctx = await requireMerchantPage('appearance');

  const [appearance, capabilityContext, productTotal] = await Promise.all([
    loadAppearance(ctx),
    loadCapabilityContext(ctx),
    // Only to label the preview honestly: zero products means the iframe is showing the sample.
    ctx.db.product.count({ where: { tenantId: ctx.tenantId } }),
  ]);

  if (!appearance) return <Empty>{t('common', 'states.empty')}</Empty>;

  return (
    <>
      <PageHead
        title={t('dashboard', 'appearance.title')}
        subtitle={t('dashboard', 'appearance.subtitle')}
      />

      <AppearanceStudio
        appearance={appearance}
        colorsCapability={capabilityContext.capabilities.colors}
        quota={capabilityContext.quota}
        sampleCatalogue={productTotal === 0}
      />
    </>
  );
}
