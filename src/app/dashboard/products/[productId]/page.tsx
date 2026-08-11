import { notFound } from 'next/navigation';
import { listMedia } from '@/server/media';
import { t } from '@/shared/i18n';
import { getProduct, listCategories } from '../../_lib/products';
import { param, requireMerchantPage } from '../../_components/guard';
import { ActionForm } from '../../_components/action-form';
import { Empty, Field, Notice, PageHead, Panel, Select, Tag, TextInput } from '../../_components/ui';
import { ProductForm } from '../_form';
import { attachImageAction, deleteProductAction, detachImageAction, makePrimaryAction } from '../actions';

/**
 * One product: its fields, and its photographs.
 *
 * Images are attached FROM THE LIBRARY rather than uploaded here, and the reason is A3's
 * pipeline: an upload is bytes, magic-byte verification, two plan limits and a queue, and it
 * lives at `/api/media/upload` behind a counting reader. A second upload path on this page
 * would be a second place to get all of that wrong. So the merchant uploads on `/media` and
 * picks here — and only READY items are offered, because A2 renders variants and an item still
 * in the pipeline has none.
 */
export const dynamic = 'force-dynamic';

export default async function ProductPage({
  params,
  searchParams,
}: {
  params: Promise<{ productId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = await requireMerchantPage('products');
  const { productId } = await params;
  const query = await searchParams;

  const product = await getProduct(ctx, productId);
  if (!product) notFound();

  const [categories, library] = await Promise.all([
    listCategories(ctx),
    listMedia(ctx.tenantId, { status: 'ready', limit: 100 }),
  ]);

  const attached = new Set(product.images.map((image) => image.mediaId));
  const available = library.items.filter((item) => !attached.has(item.id));

  return (
    <>
      <PageHead title={t('dashboard', 'products.edit')} subtitle={product.name} />

      <Notice okKey={param(query, 'ok')} errorKey={param(query, 'error')} />

      <Panel>
        <ProductForm
          product={product}
          categories={categories}
          submitLabel={t('dashboard', 'actions.saveChanges')}
        />
      </Panel>

      <Panel title={t('dashboard', 'products.fields.images')}>
        {product.images.length === 0 ? (
          <Empty>{t('dashboard', 'products.images.none')}</Empty>
        ) : (
          <div className="sbd-media-grid">
            {product.images.map((image) => (
              <div className="sbd-media-card" key={image.id}>
                <div className="sbd-media-frame">
                  {image.previewUrl ? (
                    /* A CDN variant — see product-sorter.tsx for why next/image is refused. */
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={image.previewUrl} alt={image.alt} width={320} height={240} />
                  ) : null}
                </div>
                <div className="sbd-media-body">
                  <span>{image.alt}</span>
                  {image.isPrimary ? (
                    <Tag label={t('dashboard', 'products.fields.primaryImage')} tone="ok" />
                  ) : (
                    <form action={makePrimaryAction}>
                      <input type="hidden" name="productId" value={product.id} />
                      <input type="hidden" name="productImageId" value={image.id} />
                      <button type="submit" className="sbd-btn sbd-btn--sm">
                        {t('dashboard', 'products.images.makePrimary')}
                      </button>
                    </form>
                  )}
                  <form action={detachImageAction}>
                    <input type="hidden" name="productId" value={product.id} />
                    <input type="hidden" name="productImageId" value={image.id} />
                    <button type="submit" className="sbd-btn sbd-btn--sm">
                      {t('dashboard', 'products.images.detach')}
                    </button>
                  </form>
                </div>
              </div>
            ))}
          </div>
        )}
      </Panel>

      <Panel title={t('dashboard', 'products.images.pick')}>
        {available.length === 0 ? (
          <Empty>{t('dashboard', 'products.images.libraryEmpty')}</Empty>
        ) : (
          <ActionForm action={attachImageAction} submitLabel={t('common', 'actions.add')}>
            <input type="hidden" name="productId" value={product.id} />

            <div className="sbd-grid">
              <Field label={t('dashboard', 'products.images.pick')} name="mediaId">
                <Select
                  name="mediaId"
                  options={available.map((item) => ({
                    value: item.id,
                    // The library's own alt text, or the original filename — whichever the
                    // merchant will recognise. Never the object key.
                    label: item.altText ?? item.originalName ?? item.id,
                  }))}
                />
              </Field>

              {/*
                Arabic alt text is REQUIRED on a product image (invariant 4). It is prefilled
                from the library item when the merchant already wrote one, and validated by A3 —
                which owns every length and script rule and answers in Arabic.
              */}
              <Field
                label={t('dashboard', 'products.fields.imageAlt')}
                name="alt"
                hint={t('media', 'altHint')}
              >
                <TextInput name="alt" required />
              </Field>
            </div>
          </ActionForm>
        )}
      </Panel>

      <Panel title={t('common', 'actions.delete')} note={t('dashboard', 'products.deleteConfirm')} tone="danger">
        <form action={deleteProductAction}>
          <input type="hidden" name="productId" value={product.id} />
          <button type="submit" className="sbd-btn sbd-btn--danger">
            {t('common', 'actions.delete')}
          </button>
        </form>
      </Panel>
    </>
  );
}
