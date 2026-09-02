import { notFound } from 'next/navigation';
import { t } from '@/shared/i18n';
import { BackLink, Notice, PageHead, Panel } from '../../_components/ui';
import { param, requireMerchantPage } from '../../_components/guard';
import { loadCoupon } from '../../_lib/coupons';
import { deleteCouponAction, updateCouponAction } from '../actions';
import { CouponForm } from '../_form';

export const dynamic = 'force-dynamic';

export default async function EditCouponPage({
  params,
  searchParams,
}: {
  params: Promise<{ couponId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = await requireMerchantPage('coupons');
  const { couponId } = await params;
  const query = await searchParams;

  const coupon = await loadCoupon(ctx, couponId);
  if (!coupon) notFound();

  const [categories, products] = await Promise.all([
    ctx.db.category.findMany({ where: { tenantId: ctx.tenantId }, select: { id: true, name: true }, orderBy: { sort: 'asc' } }),
    ctx.db.product.findMany({ where: { tenantId: ctx.tenantId }, select: { id: true, name: true }, orderBy: { sort: 'asc' } }),
  ]);

  return (
    <>
      <PageHead
        title={t('dashboard', 'coupons.editTitle', { code: coupon.code })}
        subtitle={t('dashboard', 'coupons.usesSummary', { used: coupon.usesCount, max: coupon.maxUses ?? '∞' })}
        actions={<BackLink href="/coupons" label={t('dashboard', 'orders.backToList')} />}
      />
      <Notice okKey={param(query, 'ok')} errorKey={param(query, 'error')} />

      <Panel title={t('dashboard', 'coupons.formTitle')}>
        <CouponForm
          action={updateCouponAction.bind(null, couponId)}
          coupon={coupon}
          categories={categories}
          products={products}
        />
      </Panel>

      <Panel title={t('dashboard', 'coupons.dangerTitle')} tone="danger">
        <p className="sbd-hint">
          {coupon.usesCount > 0
            ? t('dashboard', 'coupons.hasRedemptionsHint', { count: coupon.usesCount })
            : t('dashboard', 'coupons.deleteHint')}
        </p>
        {coupon.usesCount === 0 ? (
          <form action={deleteCouponAction}>
            <input type="hidden" name="couponId" value={coupon.id} />
            <button type="submit" className="sbd-btn sbd-btn--danger">
              {t('dashboard', 'coupons.delete')}
            </button>
          </form>
        ) : null}
      </Panel>
    </>
  );
}
