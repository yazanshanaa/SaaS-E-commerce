import { formatNumber, t } from '@/shared/i18n';
import { listCategories } from '../../_lib/products';
import { param, requireMerchantPage } from '../../_components/guard';
import { ActionForm } from '../../_components/action-form';
import {
  BackLink,
  Checkbox,
  Empty,
  Field,
  Notice,
  PageHead,
  Panel,
  Tag,
  TextInput,
} from '../../_components/ui';
import { deleteCategoryAction, saveCategoryAction } from '../actions';

/**
 * Categories.
 *
 * A scope call worth restating where it is visible: `docs/PHASES.md` lists "category" as a
 * product FIELD and never says who creates one. Nobody else can — A1's site-content tab does not
 * manage them, and B3 only seeds demo packs — so without this screen a merchant could pick a
 * category and never make one, and A2's categories section would render empty forever on every
 * real account.
 *
 * The KEY is generated once and never rewritten from a renamed category: it is the storefront's
 * stable handle and what B3's packs link products by, so a rename must not break a link a
 * merchant already sent someone.
 */
export const dynamic = 'force-dynamic';

export default async function CategoriesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = await requireMerchantPage('products');
  const params = await searchParams;
  const categories = await listCategories(ctx);

  return (
    <>
      <PageHead
        title={t('dashboard', 'categories.title')}
        subtitle={t('dashboard', 'categories.subtitle')}
        actions={<BackLink href="/products" label={t('common', 'actions.back')} />}
      />

      <Notice okKey={param(params, 'ok')} errorKey={param(params, 'error')} />

      <Panel title={t('dashboard', 'categories.add')}>
        <ActionForm action={saveCategoryAction} submitLabel={t('common', 'actions.add')}>
          <div className="sbd-grid">
            <Field label={t('dashboard', 'categories.name')} name="name">
              <TextInput name="name" required />
            </Field>
            <Field
              label={t('dashboard', 'categories.key')}
              name="key"
              hint={t('dashboard', 'categories.keyHint')}
            >
              <TextInput name="key" />
            </Field>
            <Field label={t('dashboard', 'categories.sort')} name="sort">
              <TextInput name="sort" defaultValue="0" inputMode="numeric" />
            </Field>
          </div>
          <Checkbox
            name="published"
            label={t('dashboard', 'categories.published')}
            defaultChecked
          />
        </ActionForm>
      </Panel>

      <Panel title={t('dashboard', 'categories.title')} note={t('dashboard', 'categories.deleteConfirm')}>
        {categories.length === 0 ? (
          <Empty>{t('dashboard', 'categories.empty')}</Empty>
        ) : (
          <div className="sbd-table-scroll">
            <table className="sbd-table">
              <caption className="sbd-hint">{t('dashboard', 'categories.title')}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('dashboard', 'categories.name')}</th>
                  <th scope="col">{t('dashboard', 'categories.key')}</th>
                  <th scope="col">{t('dashboard', 'categories.sort')}</th>
                  <th scope="col">{t('dashboard', 'categories.published')}</th>
                  <th scope="col">
                    <span className="sbd-hint">{t('common', 'actions.delete')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {categories.map((category) => (
                  <tr key={category.id}>
                    <th scope="row">
                      {category.name}
                      <span className="sbd-hint">
                        {t('dashboard', 'categories.productCount', {
                          count: formatNumber(category.productCount),
                        })}
                      </span>
                    </th>
                    <td className="sbd-num">{category.key}</td>
                    <td className="sbd-num">{formatNumber(category.sort)}</td>
                    <td>
                      <Tag
                        label={t(
                          'dashboard',
                          category.published ? 'products.status.published' : 'products.status.hidden',
                        )}
                        tone={category.published ? 'ok' : 'muted'}
                      />
                    </td>
                    <td>
                      <form action={deleteCategoryAction}>
                        <input type="hidden" name="categoryId" value={category.id} />
                        <button type="submit" className="sbd-btn sbd-btn--sm">
                          {t('common', 'actions.delete')}
                        </button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </>
  );
}
