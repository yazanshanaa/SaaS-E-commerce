import { t } from '@/shared/i18n';
import { loadAppearance } from '../_lib/appearance';
import { loadCapabilityContext } from '../_lib/change-requests';
import { requireMerchantPage } from '../_components/guard';
import { ActionForm } from '../_components/action-form';
import { ColorEditor } from '../_components/color-editor';
import { CapabilityTag, LockedNotice, isExhausted } from '../_components/locked-field';
import { Empty, Field, PageHead, Panel, Select, TextArea } from '../_components/ui';
import { saveColorsAction, saveTemplateAction } from './actions';

/**
 * Template and colours.
 *
 * The two are gated differently, and the screen shows the difference rather than smoothing it
 * over. The TEMPLATE is limited by `templates_allowed` — one key on أساسي, so the picker becomes
 * a statement of fact rather than a choice. COLOURS are a managed capability: where
 * `editable_by = admin` the editor still renders, filled in and read-only, with the change
 * request attached to the same submit — so the merchant picks what they want and asks for it in
 * one gesture instead of describing a colour in a text box.
 */
export const dynamic = 'force-dynamic';

export default async function AppearancePage() {
  const ctx = await requireMerchantPage('appearance');

  const [appearance, capabilityContext] = await Promise.all([
    loadAppearance(ctx),
    loadCapabilityContext(ctx),
  ]);

  if (!appearance) return <Empty>{t('common', 'states.empty')}</Empty>;

  const colors = capabilityContext.capabilities.colors;
  const locked = !colors.editable;
  const exhausted = isExhausted(capabilityContext.quota);

  return (
    <>
      <PageHead
        title={t('dashboard', 'appearance.title')}
        subtitle={t('dashboard', 'appearance.subtitle')}
      />

      <Panel
        title={t('dashboard', 'appearance.template')}
        note={appearance.singleTemplate ? t('dashboard', 'appearance.templateSingle') : undefined}
      >
        <ActionForm
          action={saveTemplateAction}
          submitLabel={t('common', 'actions.save')}
          disabled={appearance.singleTemplate}
        >
          <Field label={t('dashboard', 'appearance.template')} name="templateKey">
            <Select
              name="templateKey"
              defaultValue={appearance.templateKey}
              disabled={appearance.singleTemplate}
              options={appearance.templates.map((template) => ({
                value: template.key,
                label: `${template.name} — ${template.description}`,
              }))}
            />
          </Field>
        </ActionForm>
      </Panel>

      <Panel
        title={t('dashboard', 'appearance.colors')}
        tone={locked ? 'locked' : undefined}
        actions={<CapabilityTag capability={colors} />}
      >
        {locked ? <LockedNotice capability={colors} quota={capabilityContext.quota} /> : null}

        <ActionForm
          action={saveColorsAction}
          submitLabel={locked ? t('dashboard', 'lockedField.cta') : t('common', 'actions.save')}
          // At zero remaining the button is DISABLED and the notice above explains the ₪25
          // add-on. A submit that silently fails would be worse than one that cannot be pressed.
          disabled={locked && exhausted}
        >
          <ColorEditor
            mode={appearance.colorMode}
            presetKey={appearance.presetKey}
            colors={appearance.colors}
          />

          {locked ? (
            <Field
              label={t('dashboard', 'lockedField.note')}
              name="note"
              hint={t('dashboard', 'lockedField.noteHint')}
            >
              <TextArea name="note" rows={3} />
            </Field>
          ) : null}
        </ActionForm>
      </Panel>
    </>
  );
}
