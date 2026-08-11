import Link from 'next/link';
import { formatDate, t } from '@/shared/i18n';
import { loadLibrary } from '../_lib/media';
import { param, requireMerchantPage } from '../_components/guard';
import { ActionForm } from '../_components/action-form';
import { Checkbox, Empty, Field, PageHead, Panel, Stat, Tag, TextInput } from '../_components/ui';
import { MediaUploader } from '../_components/uploader';
import { deleteMediaAction, saveAltTextAction } from './actions';

/**
 * The merchant media library.
 *
 * A3 owns the pipeline and every rule in it — magic bytes, the two plan limits, the queue, the
 * variants, the quota counter, the delete rules. This screen is the surface over it, and it
 * deliberately shows the pipeline's own state rather than pretending an upload is instant:
 * processing happens in a worker, so a fresh photo is «قيد المعالجة» until the variants land,
 * and a product cannot use it before then.
 */
export const dynamic = 'force-dynamic';

export default async function MediaPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = await requireMerchantPage('media');
  const params = await searchParams;

  const { page, usage, usageError } = await loadLibrary(ctx, param(params, 'cursor'));

  return (
    <>
      <PageHead title={t('dashboard', 'media.title')} subtitle={t('dashboard', 'media.subtitle')} />

      <Panel title={t('media', 'upload')}>
        {usage ? (
          <dl className="sbd-stats">
            <Stat
              label={t('media', 'title')}
              value={usage.usedLabel}
              note={t('media', 'storageRemaining', { remaining: usage.remainingLabel })}
              meterPercent={usage.percentUsed}
            />
          </dl>
        ) : usageError ? (
          <div className="sbd-notice sbd-notice--info" role="status">
            {t('media', 'errors.limitsUnavailable')}
          </div>
        ) : null}

        {usage && usage.remainingBytes === 0 ? (
          <div className="sbd-notice sbd-notice--error" role="alert">
            {t('dashboard', 'media.full')}
          </div>
        ) : (
          <MediaUploader />
        )}
      </Panel>

      <Panel title={t('media', 'title')}>
        {page.items.length === 0 ? (
          <Empty>{t('media', 'empty')}</Empty>
        ) : (
          <div className="sbd-media-grid">
            {page.items.map((item) => (
              <div className="sbd-media-card" key={item.id}>
                <div className="sbd-media-frame">
                  {item.previewUrl ? (
                    /* A CDN variant — see product-sorter.tsx for why next/image is refused. */
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={item.previewUrl}
                      // The stored description IS the alt text — that is what it is for.
                      alt={item.altText ?? ''}
                      width={320}
                      height={240}
                    />
                  ) : null}
                </div>

                <div className="sbd-media-body">
                  <Tag
                    label={t('media', `status.${item.status}`)}
                    tone={item.status === 'ready' ? 'ok' : 'muted'}
                  />
                  <span className="sbd-hint">{formatDate(item.createdAt)}</span>

                  {item.failureMessage ? (
                    <span className="sbd-hint" role="alert">
                      {item.failureMessage}
                    </span>
                  ) : null}

                  <ActionForm
                    action={saveAltTextAction}
                    submitLabel={t('dashboard', 'media.saveAlt')}
                    variant="plain"
                  >
                    <input type="hidden" name="mediaId" value={item.id} />
                    <Field label={t('media', 'altLabel')} name={`alt-${item.id}`}>
                      <TextInput
                        name="altText"
                        id={`alt-${item.id}`}
                        defaultValue={item.altText ?? ''}
                      />
                    </Field>
                  </ActionForm>

                  <ActionForm
                    action={deleteMediaAction}
                    submitLabel={t('common', 'actions.delete')}
                    variant="danger"
                  >
                    <input type="hidden" name="mediaId" value={item.id} />
                    {/*
                      Forcing is opt-in and per-delete. A3 refuses a photo a product still uses,
                      because `ProductImage` cascades and deleting anyway would strip the image
                      off a live page — a merchant tidying their library would blank their own
                      shop and never be told.
                    */}
                    <Checkbox name="force" label={t('dashboard', 'media.forceDelete')} />
                  </ActionForm>
                </div>
              </div>
            ))}
          </div>
        )}

        {page.nextCursor ? (
          <p>
            <Link className="sbd-btn" href={`/media?cursor=${encodeURIComponent(page.nextCursor)}`}>
              {t('common', 'actions.next')}
            </Link>
          </p>
        ) : null}
      </Panel>
    </>
  );
}
