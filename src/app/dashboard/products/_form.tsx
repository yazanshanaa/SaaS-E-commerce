import { formatNumber, t } from '@/shared/i18n';
import {
  MAX_TAGS_PER_PRODUCT,
  MAX_TAG_LENGTH,
  type CatalogueFeatureFlags,
  type CategoryRow,
  type ProductDetail,
} from '../_lib/products';
import { ActionForm } from '../_components/action-form';
import { BackLink, Checkbox, Field, Select, TextArea, TextInput } from '../_components/ui';
import { saveProductAction } from './actions';

/**
 * How a list is joined back into the single text input that produced it.
 *
 * The Arabic comma is a DELIMITER, not copy — `parseTagList` and `parseCellList` both accept it
 * alongside the Latin comma and a newline, so what the merchant reads back is what they typed. It
 * sits in a named constant rather than inline at three call sites so the writer and the reader
 * cannot drift, which they would the first time someone "tidied" one of them to `', '`.
 */
const LIST_SEPARATOR = '، ';

/**
 * One form for create and edit.
 *
 * Two screens rendering "the same fields but slightly different" is how a field ends up saveable
 * on one and not the other — usually the one nobody demos. The only difference here is the
 * hidden id and the submit label.
 *
 * The price is entered in shekels and stored in agorot; the input is `inputMode="decimal"` and
 * not `type="number"`, because a number spinner on a phone hides the decimal point on several
 * Android keyboards and turns ₪19.90 into a fight.
 *
 * PHASE 9 ADDS THREE GATED GROUPS, and each one is ABSENT rather than disabled when its feature is
 * off — the acceptance criterion `settings/advanced/page.tsx` states, and the kinder shape: a
 * basic-plan shop owner has no use for a greyed-out box explaining what they are not paying for,
 * on every product they edit. The flags arrive resolved (`catalogueFeatureFlags`) so this
 * component never asks the entitlement layer anything, which is invariant 2 on this surface.
 */
export function ProductForm({
  product,
  categories,
  flags,
  submitLabel,
}: {
  product?: ProductDetail;
  categories: CategoryRow[];
  flags: CatalogueFeatureFlags;
  submitLabel: string;
}) {
  /** Agorot → the shekel string the field round-trips. Blank when there is no value at all. */
  const shekels = (agorot: number | null | undefined): string =>
    agorot === null || agorot === undefined ? '' : (agorot / 100).toString();

  return (
    <ActionForm action={saveProductAction} submitLabel={submitLabel} aside={<BackLink href="/products" label={t('common', 'actions.back')} />}>
      {product ? <input type="hidden" name="id" value={product.id} /> : null}

      <div className="sbd-grid">
        <Field label={t('dashboard', 'products.fields.name')} name="name">
          <TextInput name="name" defaultValue={product?.name} required />
        </Field>

        <Field
          label={t('dashboard', 'products.fields.price')}
          name="price"
          hint={t('common', 'units.currencyName')}
        >
          <TextInput
            name="price"
            defaultValue={product ? (product.priceAgorot / 100).toString() : ''}
            inputMode="decimal"
            required
          />
        </Field>

        {/*
          «السعر قبل الخصم» is NOT behind a feature flag, unlike tags and stock.

          Deliberate: the discount badge is the single most effective thing a small shop can put on
          a product card, docs/PHASE-9.md lists it as absent-today parity rather than as a plan
          differentiator, and there is no `compare_at_price` feature key in
          `src/shared/features.ts` to gate it with. Inventing one here would put a gate in the UI
          that nothing on the admin side can turn on.
        */}
        <Field
          label={t('catalogue', 'pricing.compareAt')}
          name="compareAtPrice"
          hint={t('catalogue', 'pricing.compareAtHint')}
        >
          <TextInput
            name="compareAtPrice"
            defaultValue={shekels(product?.compareAtPriceAgorot)}
            inputMode="decimal"
          />
        </Field>

        <Field label={t('dashboard', 'products.fields.category')} name="categoryId">
          <Select
            name="categoryId"
            defaultValue={product?.categoryId ?? ''}
            options={[
              { value: '', label: t('dashboard', 'products.fields.noCategory') },
              ...categories.map((category) => ({ value: category.id, label: category.name })),
            ]}
          />
        </Field>

        <Field label={t('dashboard', 'products.fields.sku')} name="sku">
          <TextInput name="sku" defaultValue={product?.sku ?? ''} />
        </Field>
      </div>

      <Field label={t('dashboard', 'products.fields.description')} name="description">
        <TextArea name="description" defaultValue={product?.description ?? ''} rows={6} />
      </Field>

      {/*
        «تفاصيل القماش والعناية» — its own field, not a paragraph inside the description. The schema
        comment says why in one line: one sells the product, the other stops a return. Ungated for
        the same reason as the compare-at price: there is no feature key for it.
      */}
      <Field
        label={t('catalogue', 'care.label')}
        name="careInstructions"
        hint={t('catalogue', 'care.hint')}
      >
        <TextArea name="careInstructions" defaultValue={product?.careInstructions ?? ''} rows={4} />
      </Field>

      {flags.tags ? (
        <Field
          label={t('catalogue', 'tags.label')}
          name="tags"
          hint={t('catalogue', 'tags.hint', {
            max: formatNumber(MAX_TAGS_PER_PRODUCT),
            length: formatNumber(MAX_TAG_LENGTH),
          })}
        >
          {/*
            One comma-separated text input, not a chip editor. A chip editor needs client state,
            and this dashboard has none anywhere (see `ActionForm`) — a merchant typing
            «صيفي، قطن، تنزيلات» into one box gets the same result with no JavaScript, and the
            normalisation that makes it safe lives server-side in `normaliseTags` either way.
          */}
          <TextInput name="tags" defaultValue={(product?.tags ?? []).join(LIST_SEPARATOR)} />
        </Field>
      ) : null}

      <div className="sbd-grid">
        <Field
          label={t('dashboard', 'products.fields.slug')}
          name="slug"
          hint={t('dashboard', 'products.fields.slugHint')}
        >
          <TextInput name="slug" defaultValue={product?.slug ?? ''} />
        </Field>

        <Field
          label={t('dashboard', 'products.fields.badge')}
          name="badge"
          hint={t('dashboard', 'products.fields.badgeHint')}
        >
          <TextInput name="badge" defaultValue={product?.badge ?? ''} />
        </Field>
      </div>

      {flags.stockTracking ? (
        <div className="sbd-grid">
          <Field
            label={t('catalogue', 'stock.policy')}
            name="stockPolicy"
            hint={t('catalogue', 'stock.policyHint')}
          >
            <Select
              name="stockPolicy"
              defaultValue={product?.stockPolicy ?? 'untracked'}
              options={[
                { value: 'untracked', label: t('catalogue', 'stock.policyOptions.untracked') },
                {
                  value: 'track_and_block',
                  label: t('catalogue', 'stock.policyOptions.track_and_block'),
                },
                {
                  value: 'track_and_allow',
                  label: t('catalogue', 'stock.policyOptions.track_and_allow'),
                },
              ]}
            />
          </Field>

          <Field
            label={t('catalogue', 'stock.quantity')}
            name="stockQty"
            hint={t('catalogue', 'stock.quantityHint')}
          >
            <TextInput
              name="stockQty"
              defaultValue={product ? String(product.stockQty) : '0'}
              inputMode="numeric"
            />
          </Field>

          <Field
            label={t('catalogue', 'stock.threshold')}
            name="lowStockThreshold"
            hint={t('catalogue', 'stock.thresholdHint', {
              fallback: formatNumber(product?.lowStockThreshold ?? 3),
            })}
          >
            <TextInput
              name="lowStockThreshold"
              defaultValue={
                product?.lowStockThreshold === null || product?.lowStockThreshold === undefined
                  ? ''
                  : String(product.lowStockThreshold)
              }
              inputMode="numeric"
            />
          </Field>
        </div>
      ) : null}

      <div className="sbd-grid">
        <Checkbox
          name="published"
          label={t('dashboard', 'products.fields.published')}
          hint={t('catalogue', 'status.hint')}
          defaultChecked={product ? product.published : true}
        />
        <Checkbox
          name="available"
          label={t('dashboard', 'products.fields.available')}
          defaultChecked={product ? product.available : true}
        />
      </div>

      {/*
        SEO fields are always present on the product form and are NOT gated by `seo_tools`.
        That flag gates the SITE-level editable metadata (docs/PHASES.md); baseline product
        metadata ships on every plan from A2, and these two columns are part of the product
        rather than a tool bolted onto it.
      */}
      <div className="sbd-grid">
        <Field label={t('dashboard', 'products.fields.seoTitle')} name="seoTitle">
          <TextInput name="seoTitle" defaultValue={product?.seoTitle ?? ''} />
        </Field>
        <Field label={t('dashboard', 'products.fields.seoDescription')} name="seoDescription">
          <TextInput name="seoDescription" defaultValue={product?.seoDescription ?? ''} />
        </Field>
      </div>
    </ActionForm>
  );
}
