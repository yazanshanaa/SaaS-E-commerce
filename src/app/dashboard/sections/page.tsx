import { t } from '@/shared/i18n';
import { loadSections } from '../_lib/sections';
import { loadCapabilityContext } from '../_lib/change-requests';
import { requireMerchantPage } from '../_components/guard';
import { ActionForm } from '../_components/action-form';
import { SectionSorter } from '../_components/section-sorter';
import { CapabilityTag, LockedNotice, isExhausted } from '../_components/locked-field';
import { Empty, Field, PageHead, Panel, TextArea } from '../_components/ui';
import { SectionConfigForm } from './_config-form';
import { saveLayoutAction } from './actions';

/**
 * The home page's sections.
 *
 * The whole screen sits behind ONE capability, `sections_layout` — admin on أساسي and متجر,
 * merchant only on احترافي (Q4: rare change, very high blast radius). A locked merchant still
 * sees every section and its settings, read-only, and the layout submit becomes a change
 * request carrying the arrangement they actually want.
 *
 * `custom_html` is additionally gated by A2's own rule and is simply not listed when it is off:
 * a raw-markup box on a plan that will never render it is an invitation to paste something that
 * silently does nothing.
 */
export const dynamic = 'force-dynamic';

export default async function SectionsPage() {
  const ctx = await requireMerchantPage('sections');

  const [view, capabilityContext] = await Promise.all([
    loadSections(ctx),
    loadCapabilityContext(ctx),
  ]);

  const capability = capabilityContext.capabilities.sections_layout;
  const locked = !view.editable;
  const exhausted = isExhausted(capabilityContext.quota);

  const visible = view.sections.filter(
    (section) => section.type !== 'custom_html' || view.customHtmlAllowed,
  );

  return (
    <>
      <PageHead
        title={t('dashboard', 'sections.title')}
        subtitle={t('dashboard', 'sections.subtitle')}
      />

      <Panel
        title={t('dashboard', 'sections.arrange')}
        tone={locked ? 'locked' : undefined}
        actions={<CapabilityTag capability={capability} />}
      >
        {locked ? <LockedNotice capability={capability} quota={capabilityContext.quota} /> : null}

        {visible.length === 0 ? (
          <Empty>{t('dashboard', 'sections.empty')}</Empty>
        ) : (
          <>
            <ol className="sbd-steps">
              <li>{t('dashboard', 'sections.step1')}</li>
              <li>{t('dashboard', 'sections.step2')}</li>
              <li>{t('dashboard', 'sections.step3')}</li>
            </ol>

            <ActionForm
              action={saveLayoutAction}
              submitLabel={locked ? t('dashboard', 'lockedField.cta') : t('common', 'actions.save')}
              disabled={locked && exhausted}
            >
              <SectionSorter
                items={visible.map((section) => ({
                  id: section.id,
                  label: t('dashboard', `sections.types.${section.type}`),
                  enabled: section.enabled,
                }))}
                showLabel={t('dashboard', 'sections.shown')}
                hideLabel={t('dashboard', 'sections.hidden')}
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
          </>
        )}
      </Panel>

      {visible.length > 0 ? (
        <Panel
          title={t('dashboard', 'sections.jumpTitle')}
          note={t('dashboard', 'sections.jumpHint')}
        >
          <p className="sbd-jump">
            {visible.map((section) => (
              <a className="sbd-tag" key={section.id} href={`#section-${section.id}`}>
                {t('dashboard', `sections.types.${section.type}`)}
              </a>
            ))}
          </p>
        </Panel>
      ) : null}

      {visible.map((section) => (
        <div id={`section-${section.id}`} className="sbd-anchor" key={section.id}>
          <Panel
            title={t('dashboard', 'sections.settingsFor', {
              name: t('dashboard', `sections.types.${section.type}`),
            })}
            actions={
              <span className={section.enabled ? 'sbd-tag sbd-tag--ok' : 'sbd-tag sbd-tag--muted'}>
                {section.enabled
                  ? t('dashboard', 'sections.shown')
                  : t('dashboard', 'sections.hidden')}
              </span>
            }
          >
            <SectionConfigForm
              sectionId={section.id}
              type={section.type}
              config={section.config}
              disabled={locked}
            />
          </Panel>
        </div>
      ))}
    </>
  );
}
