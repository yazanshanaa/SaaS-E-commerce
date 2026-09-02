import { formatNumber, t } from '@/shared/i18n';
import type { VariantPanel } from '../_lib/variants';
import { ActionForm } from '../_components/action-form';
import { Empty, Field, Panel, TextInput } from '../_components/ui';
import { deleteVariantAction, saveVariantAction, saveVariantRowAction } from './actions';

/**
 * The variant matrix — one row per sellable combination.
 *
 * SHAPE: a list of small forms, not one big form with indexed field names.
 *
 * The alternative was `variants[3].stockQty` across sixty rows submitted together, and it was
 * rejected for two reasons. First, this dashboard has no client-side form state anywhere (see
 * `ActionForm`), so adding or removing a row would need a full round trip either way — and with one
 * form per row the round trip is small and its failure is local. Second, a single submit means one
 * validation failure anywhere loses every edit on the screen: a merchant who fixes twelve stock
 * counts and mistypes the thirteenth would get «في بيانات ناقصة» and thirteen fields to re-enter.
 *
 * The trade is that reordering is per-row rather than a drag, which is the right way round: stock
 * numbers change daily and the order of sizes changes once.
 *
 * The DELETE control is a SIBLING form, never nested — nested forms are invalid HTML and browsers
 * resolve them by dropping the inner one, so the delete button would silently submit the edit.
 */
export function VariantMatrix({
  productId,
  panel,
  productPriceAgorot,
}: {
  productId: string;
  panel: VariantPanel;
  productPriceAgorot: number;
}) {
  /*
    ABSENT, not disabled. `can(tenantId,'variants')` off means this component is never rendered —
    the page checks `panel.enabled` — so this guard is the second layer for a caller that forgets,
    not the mechanism.
  */
  if (!panel.enabled) return null;

  const shekels = (agorot: number | null): string => (agorot === null ? '' : (agorot / 100).toString());

  return (
    <Panel
      title={t('catalogue', 'variants.title')}
      note={t('catalogue', 'variants.subtitle')}
      actions={
        <span className="sbd-kv">
          {t('catalogue', 'variants.totalStock')}
          <strong className="sbd-num">{formatNumber(panel.totalStock)}</strong>
        </span>
      }
    >
      <p className="sbd-hint">{t('catalogue', 'variants.totalStockHint')}</p>

      {panel.rows.length === 0 ? (
        <Empty>{t('catalogue', 'variants.empty')}</Empty>
      ) : (
        /*
          A `<ul>` of rows rather than a `<table>`, and the reason is structural rather than
          aesthetic: each row is an editable FORM, and a form cannot span the cells of a table row
          in valid HTML. The `form` attribute on every input could fake it, and that is a lot of
          fragile plumbing to buy a layout — `.sbd-grid` already lays these fields out in RTL.
        */
        <ul className="sbd-checklist">
          {panel.rows.map((row) => (
            <li key={row.id}>
              <form action={saveVariantRowAction} className="sbd-form">
                <input type="hidden" name="productId" value={productId} />
                <input type="hidden" name="id" value={row.id} />
                {/* Round-tripped so an edit cannot silently renumber the row to zero. */}
                <input type="hidden" name="sort" value={String(row.sort)} />

                <div className="sbd-grid">
                  <Field label={t('catalogue', 'variants.fields.size')} name={`size-${row.id}`}>
                    <TextInput id={`size-${row.id}`} name="size" defaultValue={row.size} />
                  </Field>

                  <Field label={t('catalogue', 'variants.fields.colour')} name={`colour-${row.id}`}>
                    <TextInput id={`colour-${row.id}`} name="colour" defaultValue={row.colour} />
                  </Field>

                  <Field label={t('catalogue', 'variants.fields.sku')} name={`sku-${row.id}`}>
                    <TextInput id={`sku-${row.id}`} name="sku" defaultValue={row.sku ?? ''} />
                  </Field>

                  <Field label={t('catalogue', 'variants.fields.stock')} name={`stockQty-${row.id}`}>
                    <TextInput
                      id={`stockQty-${row.id}`}
                      name="stockQty"
                      defaultValue={String(row.stockQty)}
                      inputMode="numeric"
                    />
                  </Field>

                  <Field
                    label={t('catalogue', 'variants.fields.price')}
                    name={`price-${row.id}`}
                    hint={
                      row.priceAgorotOverride === null
                        ? t('catalogue', 'variants.inherited')
                        : t('catalogue', 'variants.fields.priceHint')
                    }
                  >
                    <TextInput
                      id={`price-${row.id}`}
                      name="price"
                      defaultValue={shekels(row.priceAgorotOverride)}
                      inputMode="decimal"
                    />
                  </Field>
                </div>

                <div className="sbd-actions">
                  {/*
                    NOT the shared `Checkbox`: it derives its `id` from `name` and `value`, so
                    sixty rows all named `available` with value `on` would emit sixty elements with
                    `id="available-on"`. Duplicate ids are invalid HTML, an axe finding, and — worse
                    here — every `<label for>` on the screen would point at the first row's box, so
                    clicking «متوفر للبيع» on row twelve would toggle row one. Passing a unique
                    `value` instead would have broken the `checkbox()` reader, which recognises
                    exactly `on` / `true` / `1`.
                  */}
                  <label className="sbd-check" htmlFor={`available-${row.id}`}>
                    <input
                      id={`available-${row.id}`}
                      type="checkbox"
                      name="available"
                      value="on"
                      defaultChecked={row.available}
                    />
                    <span>{t('catalogue', 'variants.fields.available')}</span>
                  </label>
                  <button type="submit" className="sbd-btn sbd-btn--sm">
                    {t('common', 'actions.save')}
                  </button>
                </div>
              </form>

              <form action={deleteVariantAction}>
                <input type="hidden" name="productId" value={productId} />
                <input type="hidden" name="variantId" value={row.id} />
                <button type="submit" className="sbd-btn sbd-btn--sm">
                  {t('common', 'actions.delete')}
                </button>
              </form>
            </li>
          ))}
        </ul>
      )}

      {panel.canAdd ? (
        <ActionForm action={saveVariantAction} submitLabel={t('catalogue', 'variants.add')}>
          <input type="hidden" name="productId" value={productId} />
          {/* New rows land at the end. `sort` is a number the merchant edits per row afterwards. */}
          <input type="hidden" name="sort" value={String(panel.rows.length)} />

          {/*
            EVERY `id` HERE IS PREFIXED, and the field NAMES are not.

            This panel renders on the same page as `ProductForm`, which already has inputs named
            `sku`, `price`, `stockQty` and `available`. `Field` derives its `htmlFor` from `name` and
            `TextInput` defaults `id` to `name`, so leaving these bare emitted four pairs of
            duplicate ids on one document: invalid HTML, an axe finding, and — the part that would
            actually have been reported as a bug — every `<label>` resolving to whichever element
            came first, so clicking «المخزون» under the variant form put the cursor in the product's
            own stock box. The names have to stay as they are: they are what `variantFromForm` reads.
          */}
          <div className="sbd-grid">
            <Field
              label={t('catalogue', 'variants.fields.size')}
              name="variant-new-size"
              hint={t('catalogue', 'variants.fields.sizeHint')}
            >
              <TextInput id="variant-new-size" name="size" />
            </Field>

            <Field
              label={t('catalogue', 'variants.fields.colour')}
              name="variant-new-colour"
              hint={t('catalogue', 'variants.fields.colourHint')}
            >
              <TextInput id="variant-new-colour" name="colour" />
            </Field>

            <Field label={t('catalogue', 'variants.fields.sku')} name="variant-new-sku">
              <TextInput id="variant-new-sku" name="sku" />
            </Field>

            <Field label={t('catalogue', 'variants.fields.stock')} name="variant-new-stock">
              <TextInput
                id="variant-new-stock"
                name="stockQty"
                defaultValue="0"
                inputMode="numeric"
              />
            </Field>

            <Field
              label={t('catalogue', 'variants.fields.price')}
              name="variant-new-price"
              hint={t('catalogue', 'variants.fields.priceHint')}
            >
              {/*
                Blank means «نفس سعر المنتج», and the placeholder says which price that is — a
                merchant looking at an empty box has no way to know whether blank means free.
              */}
              <TextInput
                id="variant-new-price"
                name="price"
                inputMode="decimal"
                placeholder={(productPriceAgorot / 100).toString()}
              />
            </Field>
          </div>

          <label className="sbd-check" htmlFor="variant-new-available">
            <input
              id="variant-new-available"
              type="checkbox"
              name="available"
              value="on"
              defaultChecked
            />
            <span>{t('catalogue', 'variants.fields.available')}</span>
          </label>
        </ActionForm>
      ) : (
        <p className="sbd-notice sbd-notice--warn" role="status">
          {t('catalogue', 'variants.capReached', { max: formatNumber(panel.max) })}
        </p>
      )}
    </Panel>
  );
}
