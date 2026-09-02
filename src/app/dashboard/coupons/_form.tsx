import { t } from '@/shared/i18n';
import { ActionForm } from '../_components/action-form';
import { Checkbox, Field, Select, TextInput } from '../_components/ui';
import type { ActionState } from '../_lib/validation';
import type { CouponDetailView } from '@/server/orders';

/**
 * Shared by `/coupons/new` and `/coupons/[couponId]` — the same fields either way, only the
 * action and the defaults differ. Every scope/type combination is always rendered rather than
 * shown/hidden by client script: a merchant on a slow connection sees the whole form on first
 * paint, and the hint text under each field says when it applies (item 8's own error matrix —
 * منتهي / غير صالح / أقل من الحد الأدنى / استُخدم من قبل — is what the CUSTOMER sees; this is the
 * merchant's authoring side of the same four rules).
 */

export interface CouponFormProps {
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  coupon?: CouponDetailView;
  categories: Array<{ id: string; name: string }>;
  products: Array<{ id: string; name: string }>;
}

function dateValue(date: Date | null): string {
  return date ? date.toISOString().slice(0, 10) : '';
}

export function CouponForm({ action, coupon, categories, products }: CouponFormProps) {
  return (
    <ActionForm action={action} submitLabel={t('dashboard', coupon ? 'account.save' : 'coupons.create')}>
      <Field label={t('dashboard', 'coupons.fields.code')} name="code" hint={t('dashboard', 'coupons.codeHint')}>
        <TextInput name="code" defaultValue={coupon?.code} required autoComplete="off" />
      </Field>

      <Field label={t('dashboard', 'coupons.fields.type')} name="type">
        <Select
          name="type"
          defaultValue={coupon?.type ?? 'percent'}
          options={[
            { value: 'percent', label: t('dashboard', 'coupons.types.percent') },
            { value: 'fixed', label: t('dashboard', 'coupons.types.fixed') },
            { value: 'free_delivery', label: t('dashboard', 'coupons.types.free_delivery') },
          ]}
        />
      </Field>

      <Field
        label={t('dashboard', 'coupons.fields.value')}
        name="value"
        hint={t('dashboard', 'coupons.valueHint')}
      >
        <TextInput name="value" type="number" min="0" step="1" defaultValue={coupon?.value ?? 0} />
      </Field>

      <Field
        label={t('dashboard', 'coupons.fields.minSubtotal')}
        name="minSubtotalAgorot"
        hint={t('dashboard', 'orderSettings.agorotHint')}
      >
        <TextInput name="minSubtotalAgorot" type="number" min="0" step="1" defaultValue={coupon?.minSubtotalAgorot ?? 0} />
      </Field>

      <div className="sbd-row">
        <Field label={t('dashboard', 'coupons.fields.maxUses')} name="maxUses" hint={t('dashboard', 'coupons.maxUsesHint')}>
          <TextInput name="maxUses" type="number" min="1" step="1" defaultValue={coupon?.maxUses ?? undefined} />
        </Field>
        <Field
          label={t('dashboard', 'coupons.fields.perPhoneLimit')}
          name="perPhoneLimit"
          hint={t('dashboard', 'coupons.perPhoneLimitHint')}
        >
          <TextInput name="perPhoneLimit" type="number" min="1" step="1" defaultValue={coupon?.perPhoneLimit ?? undefined} />
        </Field>
      </div>

      <div className="sbd-row">
        <Field label={t('dashboard', 'coupons.fields.startsAt')} name="startsAt">
          <TextInput name="startsAt" type="date" defaultValue={dateValue(coupon?.startsAt ?? null)} />
        </Field>
        <Field label={t('dashboard', 'coupons.fields.endsAt')} name="endsAt">
          <TextInput name="endsAt" type="date" defaultValue={dateValue(coupon?.endsAt ?? null)} />
        </Field>
      </div>

      <Checkbox name="active" label={t('dashboard', 'coupons.fields.active')} defaultChecked={coupon?.active ?? true} />

      <Field label={t('dashboard', 'coupons.fields.scope')} name="scope" hint={t('dashboard', 'coupons.scopeHint')}>
        <Select
          name="scope"
          defaultValue={coupon?.scope ?? 'all'}
          options={[
            { value: 'all', label: t('dashboard', 'coupons.scopes.all') },
            { value: 'categories', label: t('dashboard', 'coupons.scopes.categories') },
            { value: 'products', label: t('dashboard', 'coupons.scopes.products') },
          ]}
        />
      </Field>

      {categories.length > 0 ? (
        <fieldset className="sbd-field">
          <legend className="sbd-label">{t('dashboard', 'coupons.scopeCategoriesLabel')}</legend>
          {categories.map((category) => (
            <Checkbox
              key={category.id}
              name="scopeCategoryIds"
              value={category.id}
              label={category.name}
              defaultChecked={coupon?.scopeCategoryIds.includes(category.id) ?? false}
            />
          ))}
        </fieldset>
      ) : null}

      {products.length > 0 ? (
        <fieldset className="sbd-field">
          <legend className="sbd-label">{t('dashboard', 'coupons.scopeProductsLabel')}</legend>
          {products.map((product) => (
            <Checkbox
              key={product.id}
              name="scopeProductIds"
              value={product.id}
              label={product.name}
              defaultChecked={coupon?.scopeProductIds.includes(product.id) ?? false}
            />
          ))}
        </fieldset>
      ) : null}
    </ActionForm>
  );
}
