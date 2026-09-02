import { t } from '@/shared/i18n';
import { BackLink, Notice, PageHead, Panel } from '../../_components/ui';
import { param, requireMerchantPage } from '../../_components/guard';
import { createCouponAction } from '../actions';
import { CouponForm } from '../_form';

export const dynamic = 'force-dynamic';

export default async function NewCouponPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = await requireMerchantPage('coupons');
  const query = await searchParams;

  const [categories, products] = await Promise.all([
    ctx.db.category.findMany({ where: { tenantId: ctx.tenantId }, select: { id: true, name: true }, orderBy: { sort: 'asc' } }),
    ctx.db.product.findMany({ where: { tenantId: ctx.tenantId }, select: { id: true, name: true }, orderBy: { sort: 'asc' } }),
  ]);

  return (
    <>
      <PageHead
        title={t('dashboard', 'coupons.new')}
        actions={<BackLink href="/coupons" label={t('dashboard', 'orders.backToList')} />}
      />
      <Notice okKey={param(query, 'ok')} errorKey={param(query, 'error')} />

      <Panel title={t('dashboard', 'coupons.formTitle')}>
        <CouponForm action={createCouponAction} categories={categories} products={products} />
      </Panel>
    </>
  );
}
