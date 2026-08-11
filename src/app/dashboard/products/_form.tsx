import { t } from '@/shared/i18n';
import type { CategoryRow, ProductDetail } from '../_lib/products';
import { ActionForm } from '../_components/action-form';
import { BackLink, Checkbox, Field, Select, TextArea, TextInput } from '../_components/ui';
import { saveProductAction } from './actions';

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
 */
export function ProductForm({
  product,
  categories,
  submitLabel,
}: {
  product?: ProductDetail;
  categories: CategoryRow[];
  submitLabel: string;
}) {
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

      <div className="sbd-grid">
        <Checkbox
          name="published"
          label={t('dashboard', 'products.fields.published')}
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
