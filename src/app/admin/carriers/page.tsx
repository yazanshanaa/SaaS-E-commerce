import Link from 'next/link';
import { listCarriers } from '@/server/delivery';
import { formatNumber, t } from '@/shared/i18n';
import { param, requireAdminPage } from '../_components/guard';
import { noticeKey } from '../_components/messages';
import { Checkbox, Empty, Field, Notice, PageHead, Panel, TextInput } from '../_components/ui';
import { createCarrierAction } from './actions';

/**
 * The global carrier catalogue — Q22's first half, super admin only.
 *
 * Modelled on `/admin/plans`: a list of the platform's own objects, with the create form on the
 * same screen rather than behind a `/new` route. `/plans/new` is a separate page because a plan
 * carries two whole permission matrices; a carrier is seven fields, and splitting it would turn
 * "add the courier we just signed" into two page loads.
 *
 * A HIDDEN carrier is still listed, marked, and still editable. Hiding is how a carrier is retired
 * (deleting one that shops depend on is refused, and says so), so the panel has to keep showing
 * them or an operator would think the row was gone.
 */
export const dynamic = 'force-dynamic';

export default async function CarriersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = await requireAdminPage();
  const query = await searchParams;
  const carriers = await listCarriers(ctx);

  return (
    <>
      <PageHead title={t('delivery', 'carriers.title')} subtitle={t('delivery', 'carriers.subtitle')} />

      {/* The actions redirect with a bare code; `noticeKey` bounds it to `delivery:notices.*`. */}
      <Notice
        okKey={noticeKey('delivery', param(query, 'ok'))}
        errorKey={noticeKey('delivery', param(query, 'error'))}
      />

      {carriers.length === 0 ? (
        <Empty>{t('delivery', 'carriers.empty')}</Empty>
      ) : (
        <div className="sba-table-wrap">
          <table className="sba-table">
            <caption className="sba-visually-hidden">{t('delivery', 'carriers.title')}</caption>
            <thead>
              <tr>
                <th scope="col">{t('delivery', 'carriers.table.name')}</th>
                <th scope="col">{t('delivery', 'carriers.table.key')}</th>
                <th scope="col">{t('delivery', 'carriers.table.rates')}</th>
                <th scope="col">{t('delivery', 'carriers.table.accounts')}</th>
                <th scope="col">{t('delivery', 'carriers.table.phone')}</th>
              </tr>
            </thead>
            <tbody>
              {carriers.map((carrier) => (
                <tr key={carrier.id}>
                  <td>
                    <Link href={`/carriers/${carrier.id}`}>{carrier.name}</Link>{' '}
                    {carrier.hidden ? (
                      <span className="sba-chip">{t('delivery', 'carriers.hiddenTag')}</span>
                    ) : null}
                  </td>
                  <td className="sba-mono">{carrier.key}</td>
                  <td className="sba-num">{formatNumber(carrier.rateCount)}</td>
                  <td className="sba-num">{formatNumber(carrier.assignmentCount)}</td>
                  <td className="sba-num">{carrier.phone ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Panel title={t('delivery', 'carriers.newTitle')}>
        <form action={createCarrierAction} className="sba-form">
          <Field
            label={t('delivery', 'carriers.fields.key')}
            name="key"
            hint={t('delivery', 'carriers.fields.keyHint')}
          >
            <TextInput name="key" required placeholder="yazan_express" />
          </Field>

          <Field
            label={t('delivery', 'carriers.fields.name')}
            name="name"
            hint={t('delivery', 'carriers.fields.nameHint')}
          >
            <TextInput name="name" required />
          </Field>

          <div className="sba-row">
            <Field label={t('delivery', 'carriers.fields.phone')} name="phone">
              <TextInput name="phone" type="tel" />
            </Field>
            <Field label={t('delivery', 'carriers.fields.website')} name="website">
              <TextInput name="website" type="url" />
            </Field>
            <Field label={t('delivery', 'carriers.fields.sort')} name="sort">
              <TextInput name="sort" type="number" min="0" max="999" step="1" defaultValue={0} />
            </Field>
          </div>

          <Checkbox
            name="hidden"
            label={t('delivery', 'carriers.fields.hidden')}
            hint={t('delivery', 'carriers.fields.hiddenHint')}
          />

          <button type="submit" className="sba-btn sba-btn--primary">
            {t('delivery', 'carriers.new')}
          </button>
        </form>
      </Panel>
    </>
  );
}
