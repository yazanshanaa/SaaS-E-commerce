import { notFound } from 'next/navigation';
import { formatNumber, t } from '@/shared/i18n';
import { loadHomepageExtras, type StoreStatRow } from '../../_lib/homepage';
import { loadCapabilityContext } from '../../_lib/change-requests';
import { param, requireMerchantPage } from '../../_components/guard';
import { ActionForm } from '../../_components/action-form';
import { CapabilityTag, LockedNotice, isExhausted } from '../../_components/locked-field';
import {
  BackLink,
  Checkbox,
  Empty,
  Field,
  Notice,
  PageHead,
  Panel,
  TextArea,
  TextInput,
} from '../../_components/ui';
import { deleteStoreStatAction, saveStoreStatAction } from '../actions';

/**
 * «7+ سنوات في السوق · 4000+ زبونة · 100% رضا».
 *
 * THE VALUE FIELD IS A TEXT INPUT, deliberately, and there is no `inputMode="numeric"` on it. The
 * figures a shop is proud of are "7+", "4000+" and "100%" — a numeric keypad would fight the plus and
 * the percent sign, and a number input would refuse them outright. The column is a `String` for the
 * same reason (see the model docblock), and nothing on this path calls `Number()` or `formatNumber()`
 * on it: the merchant already typed Western digits and chose their own symbol.
 */
export const dynamic = 'force-dynamic';

export default async function StoreStatsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = await requireMerchantPage('settings');
  const params = await searchParams;

  const [view, capabilityContext] = await Promise.all([
    loadHomepageExtras(ctx),
    loadCapabilityContext(ctx),
  ]);

  if (!view) notFound();

  const capability = capabilityContext.capabilities.store_stats;
  const locked = !capability.editable;
  const exhausted = isExhausted(capabilityContext.quota);
  const submitLabel = locked ? t('dashboard', 'lockedField.cta') : t('common', 'actions.save');

  return (
    <>
      <PageHead
        title={t('content', 'stats.title')}
        subtitle={t('content', 'stats.subtitle')}
        actions={<BackLink href="/content" label={t('common', 'actions.back')} />}
      />

      <Notice okKey={param(params, 'ok')} errorKey={param(params, 'error')} />

      {locked ? (
        <Panel tone="locked" actions={<CapabilityTag capability={capability} />}>
          <LockedNotice capability={capability} quota={capabilityContext.quota} />
        </Panel>
      ) : null}

      {view.stats.length === 0 ? (
        <Panel title={t('content', 'stats.row')}>
          <Empty>{t('content', 'stats.empty')}</Empty>
        </Panel>
      ) : (
        view.stats.map((stat, index) => (
          <Panel
            key={stat.id}
            title={t('content', 'stats.figure', { number: formatNumber(index + 1) })}
          >
            <StatFields
              stat={stat}
              locked={locked}
              exhausted={exhausted}
              submitLabel={submitLabel}
            />

            {locked ? null : (
              <form action={deleteStoreStatAction}>
                <input type="hidden" name="statId" value={stat.id} />
                <button type="submit" className="sbd-btn sbd-btn--sm sbd-btn--danger">
                  {t('common', 'actions.delete')}
                </button>
              </form>
            )}
          </Panel>
        ))
      )}

      <Panel
        title={t('content', 'stats.add')}
        note={t('content', 'stats.capHint', { max: formatNumber(view.maxStats) })}
      >
        {view.statCapReached ? (
          <Empty>{t('content', 'stats.capReached', { max: formatNumber(view.maxStats) })}</Empty>
        ) : (
          <StatFields
            stat={null}
            locked={locked}
            exhausted={exhausted}
            submitLabel={locked ? submitLabel : t('content', 'stats.add')}
            defaultSort={view.stats.length}
          />
        )}
      </Panel>
    </>
  );
}

function StatFields({
  stat,
  locked,
  exhausted,
  submitLabel,
  defaultSort = 0,
}: {
  stat: StoreStatRow | null;
  locked: boolean;
  exhausted: boolean;
  submitLabel: string;
  defaultSort?: number;
}) {
  return (
    <ActionForm action={saveStoreStatAction} submitLabel={submitLabel} disabled={locked && exhausted}>
      <input type="hidden" name="statId" value={stat?.id ?? ''} />

      <div className="sbd-grid">
        <Field label={t('content', 'stats.value')} name="value" hint={t('content', 'stats.valueHint')}>
          <TextInput name="value" defaultValue={stat?.value ?? ''} required />
        </Field>
        <Field label={t('content', 'stats.label')} name="label" hint={t('content', 'stats.labelHint')}>
          <TextInput name="label" defaultValue={stat?.label ?? ''} required />
        </Field>
        <Field label={t('content', 'stats.sort')} name="sort">
          <TextInput
            name="sort"
            defaultValue={formatNumber(stat?.sort ?? defaultSort)}
            inputMode="numeric"
          />
        </Field>
      </div>

      <Checkbox
        name="published"
        label={t('content', 'stats.published')}
        defaultChecked={stat?.published ?? true}
      />

      {locked ? (
        <Field
          label={t('dashboard', 'lockedField.note')}
          name="requestNote"
          hint={t('dashboard', 'lockedField.noteHint')}
        >
          <TextArea name="requestNote" rows={3} />
        </Field>
      ) : null}
    </ActionForm>
  );
}
