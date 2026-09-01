import Link from 'next/link';
import { listDemos } from '@/server/demo/admin';
import { formatNumber, t } from '@/shared/i18n';
import { param, requireAdminPage } from '../_components/guard';
import { Empty, Field, Notice, PageHead, Panel, Select, TextInput } from '../_components/ui';
import { createDemoAction } from './actions';
import { DemoAge, DemoLinkCell, DemoTabs, packLabel, packOptions } from './_components/shell';

export const dynamic = 'force-dynamic';

/**
 * Path 1 — the pack picker, and the demos it has produced.
 *
 * One screen, because the two halves are one action seen twice: you press the button and the demo
 * appears in the table underneath with a link ready to send. Everything a sales call needs is on
 * it — the link, the age, and how many products actually landed.
 *
 * AGE IS A COLUMN, not a detail. A demo has no expiry (Q2) and B1's sweep never touches one, so
 * this table is the only mechanism by which a demo opened in March and forgotten surfaces in
 * September, still serving a prospect's own phone number to anyone holding the link.
 */
export default async function DemosPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = await requireAdminPage();
  const params = await searchParams;

  const [rows, pendingRequests] = await Promise.all([
    listDemos(ctx.actor),
    ctx.db.demoRequest.count({ where: { status: 'pending' } }),
  ]);

  return (
    <>
      <PageHead title={t('demo', 'admin.title')} subtitle={t('demo', 'admin.subtitle')} />

      <DemoTabs current="/demos" pendingRequests={pendingRequests} />
      <Notice okKey={param(params, 'ok')} errorKey={param(params, 'error')} />

      <Panel title={t('demo', 'admin.create.title')} note={t('demo', 'admin.create.note')}>
        <form action={createDemoAction} className="sba-form">
          <Field label={t('demo', 'admin.create.pack')} name="packKey">
            <Select name="packKey" options={packOptions()} />
          </Field>

          <Field
            label={t('demo', 'admin.create.prefix')}
            name="slugPrefix"
            hint={t('demo', 'admin.create.prefixHint')}
          >
            <TextInput name="slugPrefix" required />
          </Field>

          <div className="sba-actions">
            <button type="submit" className="sba-btn sba-btn--primary">
              {t('demo', 'admin.create.submit')}
            </button>
          </div>
        </form>
      </Panel>

      <Panel title={t('demo', 'admin.list.title')}>
        {rows.length === 0 ? (
          <Empty>{t('demo', 'admin.list.empty')}</Empty>
        ) : (
          <div className="sba-table-wrap">
            <table className="sba-table">
              <caption className="sba-visually-hidden">{t('demo', 'admin.list.title')}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('demo', 'admin.list.columns.shop')}</th>
                  <th scope="col">{t('demo', 'admin.list.columns.pack')}</th>
                  <th scope="col">{t('demo', 'admin.list.columns.template')}</th>
                  <th scope="col">{t('demo', 'admin.list.columns.age')}</th>
                  <th scope="col">{t('demo', 'admin.list.columns.products')}</th>
                  <th scope="col">{t('demo', 'admin.list.columns.link')}</th>
                  <th scope="col">{t('demo', 'admin.list.columns.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.tenantId}>
                    {/*
                      A row HEADER, not a cell. Without it every row's two action links are
                      announced as an identical anonymous pair — "تفاصيل النسخة التجريبية, صفحة
                      الحساب" — with nothing tying them to a shop, and a table read by row is the
                      only way this screen is usable without sight.
                    */}
                    <th scope="row">
                      <Link href={`/demos/${row.tenantId}`}>{row.name}</Link>
                      <span className="sba-hint sba-mono">{row.slug}</span>
                    </th>
                    {/* The PACK, not a guess from the template — durable on the tenant since the
                        2026-08-20 migration; older demos show the request's pack while it lives. */}
                    <td>{packLabel(row.packKey)}</td>
                    <td>{row.templateName}</td>
                    <td>
                      <DemoAge days={row.ageDays} />
                    </td>
                    <td className="sba-num">{formatNumber(row.productCount)}</td>
                    <td>
                      <DemoLinkCell url={row.demoUrl} expiresAt={row.tokenExpiresAt} />
                    </td>
                    <td>
                      <div className="sba-stack">
                        <Link className="sba-btn sba-btn--sm" href={`/demos/${row.tenantId}`}>
                          {t('demo', 'admin.detail.title')}
                        </Link>
                        <Link className="sba-btn sba-btn--sm" href={`/accounts/${row.tenantId}`}>
                          {t('demo', 'admin.list.openAccount')}
                        </Link>
                      </div>
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
