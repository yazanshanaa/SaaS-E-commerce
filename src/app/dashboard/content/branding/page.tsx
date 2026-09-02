import { notFound } from 'next/navigation';
import { t } from '@/shared/i18n';
import { loadBrandingEditor } from '../../_lib/branding';
import { loadCapabilityContext } from '../../_lib/change-requests';
import { param, requireMerchantPage } from '../../_components/guard';
import { ActionForm } from '../../_components/action-form';
import { CapabilityTag, LockedNotice, isExhausted } from '../../_components/locked-field';
import { MediaPicker } from '../../_components/media-picker';
import { MediaUploader } from '../../_components/uploader';
import { BackLink, Field, Notice, PageHead, Panel, TextArea } from '../../_components/ui';
import { saveBrandingAction } from '../actions';

/**
 * The shop's three marks — and the screen the whole media picker was built for.
 *
 * Before this, `Site.logoMediaId` was settable only by a super admin or a demo pack, and
 * `settings/page.tsx` carried it through a hidden input purely so an ordinary save would not blank
 * it. `faviconMediaId` and `ogImageMediaId` had no writer anywhere: a merchant who wanted their own
 * tab icon got the generated mark, and a shared link fell back to the logo.
 *
 * ONE FORM, THREE PICKERS, ONE MEDIA READ. `loadBrandingEditor` reads the library once and hands the
 * same items to all three — the common case is that the logo and the share image are the same photo,
 * and three queries to say so would be three.
 *
 * WHAT "READ-ONLY" MEANS WHEN `logo` IS `editable_by: admin`. The pickers stay live, and that is
 * copied from `ColorEditor`'s actual behaviour rather than from the sentence beside it (the same call
 * `products/size-guide/page.tsx` records): a merchant who cannot choose cannot describe what they
 * want, and «بدي الشعار الثاني» in a text box is not a request an operator can apply. What makes it
 * read-only in the sense that matters is that nothing they pick reaches the database until an operator
 * applies it — and meanwhile the marks they already have keep rendering, which is the capability's
 * own contract.
 */
export const dynamic = 'force-dynamic';

export default async function BrandingPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = await requireMerchantPage('settings');
  const params = await searchParams;

  const [view, capabilityContext] = await Promise.all([
    loadBrandingEditor(ctx),
    loadCapabilityContext(ctx),
  ]);

  // The FEATURE, not the capability: a plan without `logo_upload` has no such screen at all.
  if (!view) notFound();

  const capability = capabilityContext.capabilities.logo;
  const locked = !capability.editable;
  const exhausted = isExhausted(capabilityContext.quota);

  return (
    <>
      <PageHead
        title={t('content', 'branding.title')}
        subtitle={t('content', 'branding.subtitle')}
        actions={<BackLink href="/content" label={t('common', 'actions.back')} />}
      />

      <Notice okKey={param(params, 'ok')} errorKey={param(params, 'error')} />

      {/*
        The uploader sits ABOVE the pickers, not inside one.

        It posts to `/api/media/upload` — a real network request that finishes with `router.refresh()`
        — while the pickers are part of a server-action form. Nesting the two would put a `<form>`
        inside a `<form>`, which is invalid HTML and silently drops the inner one in every browser.
        Uploading therefore reloads the page, and the new photo appears in all three pickers at once.
      */}
      <Panel title={t('content', 'branding.upload')} note={t('content', 'branding.uploadHint')}>
        <MediaUploader />
      </Panel>

      <Panel
        title={t('content', 'branding.marks')}
        tone={locked ? 'locked' : undefined}
        actions={<CapabilityTag capability={capability} />}
      >
        {locked ? <LockedNotice capability={capability} quota={capabilityContext.quota} /> : null}

        <ActionForm
          action={saveBrandingAction}
          submitLabel={locked ? t('dashboard', 'lockedField.cta') : t('common', 'actions.save')}
          // At zero remaining the button is DISABLED and the notice above explains the ₪25 add-on. A
          // submit that silently fails would be worse than one that cannot be pressed.
          disabled={locked && exhausted}
        >
          <MediaPicker
            name="logoMediaId"
            items={view.choices}
            selectedIds={view.logoMediaId ? [view.logoMediaId] : []}
            label={t('content', 'branding.logo')}
            hint={t('content', 'branding.logoHint')}
          />

          <MediaPicker
            name="faviconMediaId"
            items={view.choices}
            selectedIds={view.faviconMediaId ? [view.faviconMediaId] : []}
            label={t('content', 'branding.favicon')}
            hint={t('content', 'branding.faviconHint')}
          />

          <MediaPicker
            name="ogImageMediaId"
            items={view.choices}
            selectedIds={view.ogImageMediaId ? [view.ogImageMediaId] : []}
            label={t('content', 'branding.ogImage')}
            hint={t('content', 'branding.ogImageHint')}
          />

          {locked ? (
            <Field
              /* `name` matches the input's id, which `TextArea` derives from ITS name. A mismatch
                 here is a `<label for>` pointing at nothing — passes review, fails axe. */
              label={t('dashboard', 'lockedField.note')}
              name="requestNote"
              hint={t('dashboard', 'lockedField.noteHint')}
            >
              <TextArea name="requestNote" rows={3} />
            </Field>
          ) : null}
        </ActionForm>
      </Panel>
    </>
  );
}
