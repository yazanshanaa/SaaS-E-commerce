import Link from 'next/link';
import { isCartOrderStatus } from '@/server/orders';
import { formatAgorot, formatDateTime, formatNumber, messageExists, t } from '@/shared/i18n';
import { optionalMerchantContext } from './_lib/context';
import { cartOrderStatusTone } from './_lib/cart-orders';
import { orderStatusTone } from './_lib/orders';
import {
  ANALYTICS_DAYS,
  loadOverview,
  type DashboardKpis,
  type LowStockRow,
  type OverviewView,
  type RecentOrderRow,
} from './_lib/overview';
import { MerchantSignInForm } from './_components/auth-forms';
import { Empty, PageHead, Panel, Stat, Tag } from './_components/ui';

/**
 * `app.{DOMAIN}/` — the sign-in card, or the shop's own front page.
 *
 * The two live on one route on purpose: the shared hostname-resolution e2e asserts that the app
 * root never moves, and a merchant who bookmarks their dashboard should land on a sign-in form
 * at the same URL rather than being bounced somewhere else and back.
 *
 * PHASE 9 PUT THE TRADING FIGURES ABOVE THE CHECKLIST, and the order is the whole editorial argument.
 * The checklist is what a merchant needs on day one and never reads again; «مبيعات اليوم» is what they
 * open the page for on day ninety. So the KPIs come first once there is anything to say, and the
 * checklist stays exactly where it was underneath them — unchanged, still derived, still the first
 * thing on a brand-new account, which has no sales to show and nothing else to do.
 */
export const dynamic = 'force-dynamic';

export default async function DashboardHomePage() {
  const ctx = await optionalMerchantContext();
  if (!ctx) return <MerchantSignInForm />;

  const overview = await loadOverview(ctx);
  if (!overview) return <Empty>{t('common', 'states.empty')}</Empty>;

  const { stats, kpis } = overview;
  const allDone = overview.doneCount === overview.steps.length;

  return (
    <>
      <PageHead
        title={t('dashboard', 'home.title')}
        subtitle={t('dashboard', 'home.welcome', { name: overview.siteName })}
        actions={
          <a className="sbd-btn" href={overview.storefrontUrl} rel="noreferrer noopener">
            {t('dashboard', 'home.openStorefront')}
          </a>
        }
      />

      <SalesPanel kpis={kpis} stats={stats} />
      <StatusPanel kpis={kpis} />
      <RecentOrdersPanel kpis={kpis} />
      <LowStockPanel rows={kpis.lowStock} />

      <Panel title={t('dashboard', 'home.checklist')}>
        <p className="sbd-panel-note">
          {allDone
            ? t('dashboard', 'home.checklistDone')
            : t('dashboard', 'home.checklistProgress', {
                done: formatNumber(overview.doneCount),
                total: formatNumber(overview.steps.length),
              })}
        </p>

        <ul className="sbd-checklist">
          {overview.steps.map((step) => (
            <li key={step.key}>
              <Tag
                label={t('dashboard', step.done ? 'home.stepDone' : 'home.stepTodo')}
                tone={step.done ? 'ok' : 'muted'}
              />
              <span className="sbd-sortable-name">
                <Link href={step.href}>{t('dashboard', `home.steps.${step.key}`)}</Link>
              </span>
            </li>
          ))}
        </ul>
      </Panel>

      <Panel>
        <dl className="sbd-stats">
          <Stat
            label={t('dashboard', 'home.stats.products')}
            value={formatNumber(stats.products)}
            note={t('dashboard', 'home.stats.productsLimit', {
              limit: formatNumber(stats.productsLimit),
            })}
          />
          <Stat label={t('dashboard', 'home.stats.media')} value={formatNumber(stats.media)} />
          {stats.storage ? (
            <Stat
              label={t('dashboard', 'home.stats.storage')}
              value={stats.storage.usedLabel}
              note={stats.storage.label}
              meterPercent={stats.storage.percentUsed}
            />
          ) : null}
          {/*
            A visits tile appears only where the plan includes analytics AND a website was
            provisioned AND the read succeeded. أساسي sites are never tracked at all (A2 issues
            zero tracking requests for them even with consent), so a zero here would be a number
            about data that does not exist.
          */}
          {stats.visits ? (
            <Stat
              label={t('dashboard', 'home.stats.visits', {
                days: formatNumber(stats.visits.days),
              })}
              value={formatNumber(stats.visits.visitors)}
            />
          ) : null}
        </dl>
        <p className="sbd-hint">{t('dashboard', 'home.storefrontHint')}</p>
      </Panel>
    </>
  );
}

/**
 * «مبيعات اليوم / آخر 7 أيام / آخر 30 يوم / متوسط قيمة الطلب».
 *
 * ABSENT FOR STAFF, not zeroed and not disabled: `kpis.sales` is null when the role does not reach it,
 * and the panel renders nothing at all. A staff member still reads every individual order total on
 * the orders screen — which is the number packing an order needs — and a shop's revenue is a business
 * fact in the same family as `analytics`, which has been owner-only since Q13.
 *
 * The visitors tile rides along here rather than in the tile row below, because it answers the same
 * question the money does («شو صار هذا الأسبوع») and because it only exists at all for a shop with
 * `visitor_analytics` and no Umami site.
 */
function SalesPanel({ kpis, stats }: { kpis: DashboardKpis; stats: OverviewView['stats'] }) {
  const { sales } = kpis;
  if (!sales) return null;

  /*
   * The merchant's money, and the one panel this screen exists for — so it carries the bloom, and
   * it is the only panel on the page that does. `SalesPanel` returns null for staff (above), so a
   * staff member simply gets no bloomed panel rather than the bloom migrating to a lesser one.
   */
  return (
    <Panel title={t('customers', 'kpi.title')} note={t('customers', 'kpi.moneyNote')} bloom>
      <dl className="sbd-stats">
        <Stat
          label={t('customers', 'kpi.today')}
          value={formatAgorot(sales.today.agorot)}
          note={t('customers', 'kpi.ordersNote', { count: formatNumber(sales.today.orders) })}
        />
        <Stat
          label={t('customers', 'kpi.week', { days: formatNumber(sales.weekDays) })}
          value={formatAgorot(sales.week.agorot)}
          note={t('customers', 'kpi.ordersNote', { count: formatNumber(sales.week.orders) })}
        />
        <Stat
          label={t('customers', 'kpi.month', { days: formatNumber(sales.monthDays) })}
          value={formatAgorot(sales.month.agorot)}
          note={t('customers', 'kpi.ordersNote', { count: formatNumber(sales.month.orders) })}
        />
        <Stat
          label={t('customers', 'kpi.average')}
          value={formatAgorot(sales.averageOrderAgorot)}
          note={t('customers', 'kpi.averageNote', { days: formatNumber(sales.monthDays) })}
        />
        {stats.firstPartyVisitorDays === null ? null : (
          <Stat
            label={t('customers', 'kpi.visitors', { days: formatNumber(ANALYTICS_DAYS) })}
            value={formatNumber(stats.firstPartyVisitorDays)}
            // The label alone would overstate it: this is a sum of daily uniques, because the visitor
            // key is salted per day and cannot be joined across days. Said here rather than left for
            // a merchant to discover by comparing it against something else.
            note={t('customers', 'kpi.visitorsNote')}
          />
        )}
      </dl>
    </Panel>
  );
}

/**
 * Order counts per status, each one a LINK into the filtered list.
 *
 * Links rather than plain numbers because a count is only useful if the next click is the work: «3
 * جديد» on this screen and `/orders?status=new` are the same sentence, and the orders list already
 * reads that exact parameter. Every status of the shop's own vocabulary renders, including the zeros —
 * «ملغي: 0» is information, and a tile that disappears when it reaches zero is a tile a merchant
 * cannot trust the absence of.
 */
function StatusPanel({ kpis }: { kpis: DashboardKpis }) {
  const total = kpis.statusCounts.reduce((sum, row) => sum + row.count, 0);
  if (total === 0) return null;

  return (
    <Panel title={t('customers', 'kpi.statusesTitle')} note={t('customers', 'kpi.statusesNote')}>
      <nav className="sbd-actions" aria-label={t('customers', 'kpi.statusesTitle')}>
        {kpis.statusCounts.map((row) => (
          <Link key={row.status} className="sbd-btn sbd-btn--sm" href={row.href}>
            {statusLabel(kpis.channel, row.status)}
            {/* The number is inside the link, not beside it: a merchant taps the count, and a tap
                target that excludes the thing you aimed at is the most common phone-sized mistake. */}
            <span className="sbd-tag" style={{ marginInlineStart: '0.4em' }}>
              {formatNumber(row.count)}
            </span>
          </Link>
        ))}
      </nav>
    </Panel>
  );
}

function RecentOrdersPanel({ kpis }: { kpis: DashboardKpis }) {
  if (kpis.recent.length === 0) {
    // Shown rather than hidden, unlike the panels above: on a shop with no orders this sentence is
    // the answer to "did the site take anything", and silence is not.
    return (
      <Panel title={t('customers', 'kpi.recentTitle')}>
        <Empty>{t('customers', 'kpi.recentEmpty')}</Empty>
      </Panel>
    );
  }

  return (
    <Panel
      title={t('customers', 'kpi.recentTitle')}
      actions={
        <Link className="sbd-btn sbd-btn--sm" href="/orders">
          {t('dashboard', 'orders.title')}
        </Link>
      }
    >
      <div className="sbd-table-scroll">
        <table className="sbd-table">
          <caption className="sbd-hint">{t('customers', 'kpi.recentTitle')}</caption>
          <thead>
            <tr>
              <th scope="col">{t('dashboard', 'orders.fields.number')}</th>
              <th scope="col">{t('dashboard', 'orders.fields.customer')}</th>
              <th scope="col">{t('dashboard', 'orders.fields.total')}</th>
              <th scope="col">{t('dashboard', 'orders.fields.status')}</th>
              <th scope="col">{t('dashboard', 'orders.fields.placedAt')}</th>
              <th scope="col">
                <span className="sbd-hint">{t('dashboard', 'orders.open')}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {kpis.recent.map((row) => (
              <tr key={row.id}>
                <th scope="row" className="sbd-num">
                  {formatNumber(row.number)}
                </th>
                <td>{row.customerName ?? t('dashboard', 'orders.noCustomerName')}</td>
                <td className="sbd-num">{formatAgorot(row.totalAgorot)}</td>
                <td>
                  <Tag
                    label={statusLabel(kpis.channel, row.status)}
                    tone={statusTone(kpis.channel, row)}
                  />
                </td>
                <td className="sbd-num">{formatDateTime(row.placedAt)}</td>
                <td>
                  <Link className="sbd-btn sbd-btn--sm" href={`/orders/${row.id}`}>
                    {t('dashboard', 'orders.open')}
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

/**
 * «قارب على النفاد».
 *
 * Null means the shop does not track stock at all, and then the panel is ABSENT — an empty low-stock
 * report on a grocer who counts nothing is permanent furniture that never says anything. An empty
 * ARRAY is different: the shop counts and nothing is short, which is good news and worth printing.
 */
function LowStockPanel({ rows }: { rows: LowStockRow[] | null }) {
  if (rows === null) return null;

  return (
    <Panel
      title={t('customers', 'kpi.lowStockTitle')}
      note={t('customers', 'kpi.lowStockNote')}
      tone={rows.length > 0 ? 'danger' : undefined}
    >
      {rows.length === 0 ? (
        <Empty>{t('customers', 'kpi.lowStockEmpty')}</Empty>
      ) : (
        <div className="sbd-table-scroll">
          <table className="sbd-table">
            <caption className="sbd-hint">{t('customers', 'kpi.lowStockTitle')}</caption>
            <thead>
              <tr>
                <th scope="col">{t('customers', 'kpi.lowStock.product')}</th>
                <th scope="col">{t('customers', 'kpi.lowStock.variant')}</th>
                <th scope="col">{t('customers', 'kpi.lowStock.remaining')}</th>
                <th scope="col">{t('customers', 'kpi.lowStock.threshold')}</th>
                <th scope="col">
                  <span className="sbd-hint">{t('customers', 'kpi.lowStock.open')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={`${row.productId}:${row.variantId ?? ''}`}>
                  <th scope="row">{row.name}</th>
                  <td>{row.variantLabel ?? t('customers', 'kpi.lowStock.noVariant')}</td>
                  <td className="sbd-num">{formatNumber(row.quantity)}</td>
                  <td className="sbd-num">{formatNumber(row.threshold)}</td>
                  <td>
                    <Link className="sbd-btn sbd-btn--sm" href={`/products/${row.productId}`}>
                      {t('customers', 'kpi.lowStock.open')}
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

/**
 * A status, in whichever of the two vocabularies this shop trades in.
 *
 * The labels already exist under `dashboard:orders.statuses.*` and `dashboard:orders.cartStatuses.*`,
 * and they are reused rather than re-translated so this screen and the orders list cannot come to
 * disagree about the word for «ملغي». `messageExists` guards the pair because `t()` throws on a
 * missing key outside production, and an impossible channel/status combination should render one odd
 * cell rather than take the whole dashboard down.
 */
function statusLabel(channel: DashboardKpis['channel'], status: string): string {
  const key = channel === 'cart' ? `orders.cartStatuses.${status}` : `orders.statuses.${status}`;
  return messageExists('dashboard', key) ? t('dashboard', key) : status;
}

/** Both existing tone helpers, reused for the same reason as the labels. */
function statusTone(
  channel: DashboardKpis['channel'],
  row: RecentOrderRow,
): 'ok' | 'muted' | undefined {
  if (channel === 'cart') {
    return isCartOrderStatus(row.status) ? cartOrderStatusTone(row.status) : undefined;
  }
  return orderStatusTone(row.status);
}
