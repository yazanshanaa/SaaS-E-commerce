import { notFound } from 'next/navigation';
import { formatDate, formatNumber, t } from '@/shared/i18n';
import { loadBannerEditor, type BannerRow } from '../../_lib/banners';
import { loadCapabilityContext } from '../../_lib/change-requests';
import { param, requireMerchantPage } from '../../_components/guard';
import { ActionForm } from '../../_components/action-form';
import { CapabilityTag, LockedNotice, isExhausted } from '../../_components/locked-field';
import { MediaPicker, type MediaPickerItem } from '../../_components/media-picker';
import {
  BackLink,
  Checkbox,
  Empty,
  Field,
  Notice,
  PageHead,
  Panel,
  Tag,
  TextArea,
  TextInput,
} from '../../_components/ui';
import { deleteBannerAction, saveBannerAction } from '../actions';

/**
 * The banner board — up to six image slides on the homepage.
 *
 * ONE FORM PER BANNER, and one more at the bottom for a new one. A banner carries an image, a
 * headline, a subtitle, a CTA pair and a schedule; putting six of those in a single submit means a
 * validation failure on the fourth throws away the merchant's edits to the first three, and the form
 * becomes something nobody reads before pressing save.
 *
 * THE STATE COLUMN IS THE POINT OF THE TABLE. A banner can be invisible for four different reasons —
 * unpublished, no image, no description, or outside its window — and «مش ظاهر» without saying which
 * is how a merchant concludes the slider is broken. Each row says exactly which one applies, in the
 * order the service checks them.
 */
export const dynamic = 'force-dynamic';

function toDateInput(value: Date | null): string {
  return value ? value.toISOString().slice(0, 10) : '';
}

/** Why this banner is or is not on the page right now, in the order `isRenderableBanner` asks. */
function stateKey(banner: BannerRow, now: Date): { key: string; live: boolean } {
  if (!banner.published) return { key: 'banners.state.draft', live: false };
  if (!banner.imageMediaId) return { key: 'banners.state.noImage', live: false };
  if (!banner.alt || banner.alt.trim() === '') return { key: 'banners.state.noAlt', live: false };
  if (banner.startsAt && banner.startsAt > now) return { key: 'banners.state.scheduled', live: false };
  if (banner.endsAt && banner.endsAt < now) return { key: 'banners.state.ended', live: false };
  return { key: 'banners.state.live', live: true };
}

export default async function BannersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = await requireMerchantPage('settings');
  const params = await searchParams;

  const [view, capabilityContext] = await Promise.all([
    loadBannerEditor(ctx),
    loadCapabilityContext(ctx),
  ]);

  // The FEATURE: a plan without `banners_slider` has no board at all.
  if (!view) notFound();

  const capability = capabilityContext.capabilities.banners;
  const locked = !capability.editable;
  const exhausted = isExhausted(capabilityContext.quota);
  const submitLabel = locked ? t('dashboard', 'lockedField.cta') : t('common', 'actions.save');
  const now = new Date();

  return (
    <>
      <PageHead
        title={t('content', 'banners.title')}
        subtitle={t('content', 'banners.subtitle')}
        actions={<BackLink href="/content" label={t('common', 'actions.back')} />}
      />

      <Notice okKey={param(params, 'ok')} errorKey={param(params, 'error')} />

      {locked ? (
        <Panel tone="locked" actions={<CapabilityTag capability={capability} />}>
          <LockedNotice capability={capability} quota={capabilityContext.quota} />
        </Panel>
      ) : null}

      {view.banners.length === 0 ? (
        <Panel title={t('content', 'banners.board')}>
          <Empty>{t('content', 'banners.empty')}</Empty>
        </Panel>
      ) : (
        view.banners.map((banner, index) => {
          const state = stateKey(banner, now);

          return (
            <Panel
              key={banner.id}
              title={t('content', 'banners.slide', { number: formatNumber(index + 1) })}
              actions={
                <Tag label={t('content', state.key)} tone={state.live ? 'ok' : 'muted'} />
              }
            >
              <BannerFields
                banner={banner}
                choices={view.choices}
                locked={locked}
                exhausted={exhausted}
                submitLabel={submitLabel}
              />

              {/*
                Delete is its own form, redirect-style, matching every other list-row action on this
                surface. It is absent when the capability is locked: the merchant cannot delete
                content they cannot edit, and offering a button that refuses is worse than not
                offering it.
              */}
              {locked ? null : (
                <form action={deleteBannerAction}>
                  <input type="hidden" name="bannerId" value={banner.id} />
                  <button type="submit" className="sbd-btn sbd-btn--sm sbd-btn--danger">
                    {t('common', 'actions.delete')}
                  </button>
                </form>
              )}
            </Panel>
          );
        })
      )}

      <Panel
        title={t('content', 'banners.add')}
        note={
          view.capReached
            ? t('content', 'banners.capReached', { max: formatNumber(view.maxBanners) })
            : t('content', 'banners.capHint', { max: formatNumber(view.maxBanners) })
        }
      >
        {view.capReached ? (
          <Empty>{t('content', 'banners.capReached', { max: formatNumber(view.maxBanners) })}</Empty>
        ) : (
          <BannerFields
            banner={null}
            choices={view.choices}
            locked={locked}
            exhausted={exhausted}
            submitLabel={locked ? submitLabel : t('content', 'banners.add')}
            defaultSort={view.banners.length}
          />
        )}
      </Panel>
    </>
  );
}

/**
 * One banner's fields. Shared by the edit rows and the "add" panel so the two cannot drift — the
 * failure that shape prevents is a field the create form offers and the edit form silently drops.
 */
function BannerFields({
  banner,
  choices,
  locked,
  exhausted,
  submitLabel,
  defaultSort = 0,
}: {
  banner: BannerRow | null;
  choices: MediaPickerItem[];
  locked: boolean;
  exhausted: boolean;
  submitLabel: string;
  defaultSort?: number;
}) {
  return (
    <ActionForm action={saveBannerAction} submitLabel={submitLabel} disabled={locked && exhausted}>
      <input type="hidden" name="bannerId" value={banner?.id ?? ''} />

      <MediaPicker
        name="imageMediaId"
        items={choices}
        selectedIds={banner?.imageMediaId ? [banner.imageMediaId] : []}
        label={t('content', 'banners.image')}
        hint={t('content', 'banners.imageHint')}
      />

      <Field
        label={t('content', 'banners.alt')}
        name="alt"
        hint={t('content', 'banners.altHint')}
      >
        {/*
          The alt text is asked for HERE as well as on the media screen, and the two are different
          questions: `Media.altText` describes the photograph, this describes what the SLIDE says. A
          banner reading «خصم 30% على الشتوي» over a picture of a coat needs the offer in its
          description, not «معطف صوف بيج» — which is what a screen-reader user would otherwise be told
          the largest thing on the homepage is.
        */}
        <TextInput name="alt" defaultValue={banner?.alt ?? ''} />
      </Field>

      <div className="sbd-grid">
        <Field label={t('content', 'banners.headline')} name="title">
          <TextInput name="title" defaultValue={banner?.title ?? ''} required />
        </Field>
        {/* `banners.tagline`, not `banners.subtitle`: that key is the SCREEN's subtitle, and reusing
            it here put a page-level sentence on a field label — caught before it shipped, and the
            reason field keys on this screen are named after the field rather than after its shape. */}
        <Field label={t('content', 'banners.tagline')} name="subtitle">
          <TextInput name="subtitle" defaultValue={banner?.subtitle ?? ''} />
        </Field>
      </div>

      <div className="sbd-grid">
        <Field
          label={t('content', 'banners.ctaLabel')}
          name="ctaLabel"
          hint={t('content', 'banners.ctaLabelHint')}
        >
          <TextInput name="ctaLabel" defaultValue={banner?.ctaLabel ?? ''} />
        </Field>
        <Field
          label={t('content', 'banners.ctaHref')}
          name="ctaHref"
          /*
            The example path travels as a PARAMETER, not inside the copy. `/products` is a placeholder
            rather than vocabulary, and the language gate refuses a bare Latin word in an Arabic value
            for exactly that reason — the same treatment Phase 4 gave its example hostnames.
          */
          hint={t('content', 'banners.ctaHrefHint', { example: '/products' })}
        >
          <TextInput name="ctaHref" defaultValue={banner?.ctaHref ?? ''} inputMode="url" />
        </Field>
      </div>

      <div className="sbd-grid">
        <Field label={t('content', 'banners.sort')} name="sort">
          <TextInput
            name="sort"
            defaultValue={formatNumber(banner?.sort ?? defaultSort)}
            inputMode="numeric"
          />
        </Field>
        <Field
          label={t('content', 'banners.startsAt')}
          name="startsAt"
          hint={t('content', 'banners.scheduleHint')}
        >
          <TextInput name="startsAt" type="date" defaultValue={toDateInput(banner?.startsAt ?? null)} />
        </Field>
        <Field label={t('content', 'banners.endsAt')} name="endsAt">
          <TextInput name="endsAt" type="date" defaultValue={toDateInput(banner?.endsAt ?? null)} />
        </Field>
      </div>

      <Checkbox
        name="published"
        label={t('content', 'banners.published')}
        hint={t('content', 'banners.publishedHint')}
        defaultChecked={banner?.published ?? false}
      />

      {banner?.startsAt || banner?.endsAt ? (
        <p className="sbd-hint">
          {t('content', 'banners.window', {
            from: banner.startsAt ? formatDate(banner.startsAt) : '—',
            to: banner.endsAt ? formatDate(banner.endsAt) : '—',
          })}
        </p>
      ) : null}

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
