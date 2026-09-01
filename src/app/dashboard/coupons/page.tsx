import Link from 'next/link';
import { can } from '@/server/entitlements';
import { formatDate, formatNumber, t } from '@/shared/i18n';
import { param, requireMerchantPage } from '../_components/guard';
import { Empty, Notice, PageHead, Panel, Tag } from '../_components/ui';
import { loadCoupons } from '../_lib/coupons';
import { toggleCouponAction } from './actions';

/**
 * Coupon list (Phase 8, item 8). Owner-only (`coupons` is not in `STAFF_ALLOWED`,
 * src/server/auth/rbac.ts) and feature-gated on `can(tenantId,'coupons')` through the same scope
 * check `requireMerchantPage` already makes — a تجر-tier tenant without `coupons` never reaches
 * this route at all, the nav link included.
 */
export const dynamic = 'force-dynamic';

function couponValueLabel(coupon: { type: string; value: number }): string {
  if (coupon.type === 'percent') return `${formatNumber(coupon.value)}%`;
  if (coupon.type === 'free_delivery') return t('dashboard', 'coupons.types.free_delivery');
  return `${(coupon.value / 100).toFixed(2)} ₪`;
}

export default async function CouponsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = await requireMerchantPage('coupons');
  const query = await searchParams;
  const [coupons, cartOn] = await Promise.all([loadCoupons(ctx), can(ctx.tenantId, 'cart')]);

  return (
    <>
      <PageHead
        title={t('dashboard', 'coupons.title')}
        subtitle={t('dashboard', 'coupons.subtitle')}
        actions={
          <Link className="sbd-btn sbd-btn--primary sbd-btn--sm" href="/coupons/new">
            {t('dashboard', 'coupons.new')}
          </Link>
        }
      />

      <Notice okKey={param(query, 'ok')} errorKey={param(query, 'error')} />

      {!cartOn ? <Panel note={t('dashboard', 'coupons.cartOffHint')}>{null}</Panel> : null}

      <Panel title={t('dashboard', 'coupons.count', { count: formatNumber(coupons.length) })}>
        {coupons.length === 0 ? (
          <Empty>{t('dashboard', 'coupons.empty')}</Empty>
        ) : (
          <div className="sbd-table-scroll">
            <table className="sbd-table">
              <caption className="sbd-hint">{t('dashboard', 'coupons.title')}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('dashboard', 'coupons.fields.code')}</th>
                  <th scope="col">{t('dashboard', 'coupons.fields.value')}</th>
                  <th scope="col">{t('dashboard', 'coupons.fields.uses')}</th>
                  <th scope="col">{t('dashboard', 'coupons.fields.window')}</th>
                  <th scope="col">{t('dashboard', 'coupons.fields.status')}</th>
                  <th scope="col">
                    <span className="sbd-hint">{t('dashboard', 'orders.open')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {coupons.map((coupon) => (
                  <tr key={coupon.id}>
                    <th scope="row" className="sbd-code">
                      {coupon.code}
                    </th>
                    <td>{couponValueLabel(coupon)}</td>
                    <td className="sbd-num">
                      {formatNumber(coupon.usesCount)}
                      {coupon.maxUses !== null ? ` / ${formatNumber(coupon.maxUses)}` : ''}
                    </td>
                    <td className="sbd-num">
                      {coupon.startsAt ? formatDate(coupon.startsAt) : '—'}
                      {' … '}
                      {coupon.endsAt ? formatDate(coupon.endsAt) : '—'}
                    </td>
                    <td>
                      <Tag
                        label={t('dashboard', coupon.active ? 'coupons.active' : 'coupons.inactive')}
                        tone={coupon.active ? 'ok' : 'muted'}
                      />
                    </td>
                    <td>
                      <div className="sbd-actions">
                        <Link className="sbd-btn sbd-btn--sm" href={`/coupons/${coupon.id}`}>
                          {t('dashboard', 'orders.open')}
                        </Link>
                        <form action={toggleCouponAction}>
                          <input type="hidden" name="couponId" value={coupon.id} />
                          <input type="hidden" name="active" value={coupon.active ? 'false' : 'true'} />
                          <button type="submit" className="sbd-btn sbd-btn--sm">
                            {t('dashboard', coupon.active ? 'coupons.deactivate' : 'coupons.activate')}
                          </button>
                        </form>
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
