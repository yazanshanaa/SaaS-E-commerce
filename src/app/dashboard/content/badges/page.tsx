import { notFound } from 'next/navigation';
import { formatNumber, t } from '@/shared/i18n';
import { loadHomepageExtras, type TrustBadgeRow } from '../../_lib/homepage';
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
  Select,
  TextArea,
  TextInput,
} from '../../_components/ui';
import { deleteTrustBadgeAction, saveTrustBadgeAction } from '../actions';

/**
 * The trust row — «توصيل مجاني فوق ₪400» / «ادفعي لما توصلك» / «تغليف محتشم».
 *
 * THE ICON IS A SELECT OVER A CLOSED SET, never a text field and never an emoji. CLAUDE.md forbids
 * emoji as icons and `components/icons.tsx` records the reason beyond taste: an emoji renders as a
 * different picture on every platform, is announced as a word by a screen reader, and has no
 * relationship to the template's colours. The keys come from `TRUST_ICON_KEYS`, which the section's
 * glyph map is unit-tested against — so an option offered here always has a picture behind it.
 *
 * Three claims fit a phone; four is the cap and the honest maximum before the row wraps into a
 * paragraph and stops being scannable, which is the entire function of a trust row.
 */
export const dynamic = 'force-dynamic';

export default async function TrustBadgesPage({
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

  const capability = capabilityContext.capabilities.trust_badges;
  const locked = !capability.editable;
  const exhausted = isExhausted(capabilityContext.quota);
  const submitLabel = locked ? t('dashboard', 'lockedField.cta') : t('common', 'actions.save');

  const iconOptions = view.iconKeys.map((key) => ({
    value: key,
    label: t('content', `badges.icons.${key}`),
  }));

  return (
    <>
      <PageHead
        title={t('content', 'badges.title')}
        subtitle={t('content', 'badges.subtitle')}
        actions={<BackLink href="/content" label={t('common', 'actions.back')} />}
      />

      <Notice okKey={param(params, 'ok')} errorKey={param(params, 'error')} />

      {locked ? (
        <Panel tone="locked" actions={<CapabilityTag capability={capability} />}>
          <LockedNotice capability={capability} quota={capabilityContext.quota} />
        </Panel>
      ) : null}

      {view.badges.length === 0 ? (
        <Panel title={t('content', 'badges.row')}>
          <Empty>{t('content', 'badges.empty')}</Empty>
        </Panel>
      ) : (
        view.badges.map((badge, index) => (
          <Panel
            key={badge.id}
            title={t('content', 'badges.claim', { number: formatNumber(index + 1) })}
          >
            <BadgeFields
              badge={badge}
              iconOptions={iconOptions}
              locked={locked}
              exhausted={exhausted}
              submitLabel={submitLabel}
            />

            {locked ? null : (
              <form action={deleteTrustBadgeAction}>
                <input type="hidden" name="badgeId" value={badge.id} />
                <button type="submit" className="sbd-btn sbd-btn--sm sbd-btn--danger">
                  {t('common', 'actions.delete')}
                </button>
              </form>
            )}
          </Panel>
        ))
      )}

      <Panel
        title={t('content', 'badges.add')}
        note={t('content', 'badges.capHint', { max: formatNumber(view.maxBadges) })}
      >
        {view.badgeCapReached ? (
          <Empty>{t('content', 'badges.capReached', { max: formatNumber(view.maxBadges) })}</Empty>
        ) : (
          <BadgeFields
            badge={null}
            iconOptions={iconOptions}
            locked={locked}
            exhausted={exhausted}
            submitLabel={locked ? submitLabel : t('content', 'badges.add')}
            defaultSort={view.badges.length}
          />
        )}
      </Panel>
    </>
  );
}

function BadgeFields({
  badge,
  iconOptions,
  locked,
  exhausted,
  submitLabel,
  defaultSort = 0,
}: {
  badge: TrustBadgeRow | null;
  iconOptions: Array<{ value: string; label: string }>;
  locked: boolean;
  exhausted: boolean;
  submitLabel: string;
  defaultSort?: number;
}) {
  return (
    <ActionForm
      action={saveTrustBadgeAction}
      submitLabel={submitLabel}
      disabled={locked && exhausted}
    >
      <input type="hidden" name="badgeId" value={badge?.id ?? ''} />

      <div className="sbd-grid">
        <Field label={t('content', 'badges.icon')} name="icon" hint={t('content', 'badges.iconHint')}>
          <Select name="icon" defaultValue={badge?.icon ?? 'check'} options={iconOptions} />
        </Field>
        <Field label={t('content', 'badges.claimTitle')} name="title">
          <TextInput name="title" defaultValue={badge?.title ?? ''} required />
        </Field>
        <Field
          label={t('content', 'badges.claimSubtitle')}
          name="subtitle"
          hint={t('content', 'badges.claimSubtitleHint')}
        >
          <TextInput name="subtitle" defaultValue={badge?.subtitle ?? ''} />
        </Field>
        <Field label={t('content', 'badges.sort')} name="sort">
          <TextInput
            name="sort"
            defaultValue={formatNumber(badge?.sort ?? defaultSort)}
            inputMode="numeric"
          />
        </Field>
      </div>

      <Checkbox
        name="published"
        label={t('content', 'badges.published')}
        defaultChecked={badge?.published ?? true}
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
