import { notFound } from 'next/navigation';
import { loadInsights, type InsightsView, type TermRow } from '@/server/analytics';
import { roleHasScope } from '@/server/auth';
import { can } from '@/server/entitlements';
import { formatNumber, t } from '@/shared/i18n';
import { requireMerchantPage } from '../_components/guard';
import { Empty, PageHead, Panel, Stat } from '../_components/ui';

/**
 * «سلوك الزوار» — the first-party analytics report.
 *
 * A NEW SCREEN BESIDE `/analytics`, not a replacement for it. That one reads Umami and answers "how
 * many people came"; this one reads the platform's own rollups and answers the questions Umami
 * cannot — which section did they read, and for how long, and what did they search for and not find.
 * Two data sources, two screens, and neither pretends to be the other.
 *
 * IT READS ROLLUPS AND NOTHING ELSE. `analytics_events` is never queried from here: it holds at most
 * thirty days, it is the largest table on the platform, and a dashboard query against it would be a
 * range scan a merchant can trigger by refreshing. See `src/server/analytics/report.ts`.
 *
 * THE GUARD IS `can('visitor_analytics')` AND A 404. Not a 403 and not an upsell —
 * `_components/guard.ts` sets out why: telling a basic-plan merchant that a screen exists behind a
 * plan is a sales pitch nobody asked this page to make, and telling a staff member that a screen is
 * not theirs is an inventory of what to go looking for.
 *
 * Two gates rather than `requireMerchantPage('analytics')`, because that scope is wired to the
 * `analytics` FEATURE KEY (src/server/auth/rbac.ts) and this screen is gated on `visitor_analytics`
 * — a different key that an admin can turn on and off independently. The handoff doc carries the diff
 * that adds an `insights` scope and folds both halves back into one call; until then the role half is
 * asked explicitly so a staff member cannot reach this by URL.
 */
export const dynamic = 'force-dynamic';

/** Milliseconds to a whole number of seconds, for display. Averages are already rounded. */
function seconds(ms: number): string {
  return formatNumber(Math.round(ms / 1000));
}

export default async function InsightsPage() {
  const ctx = await requireMerchantPage();

  // Owner-only, matching `analytics`: visitor behaviour is a business report, not shop-floor work.
  if (!roleHasScope(ctx.role, 'analytics')) notFound();
  if ((await can(ctx.tenantId, 'visitor_analytics')) !== true) notFound();

  const [view, searchAvailable] = await Promise.all([
    loadInsights(ctx.db, ctx.tenantId),
    can(ctx.tenantId, 'search_insights'),
  ]);

  return (
    <>
      <PageHead
        title={t('insights', 'report.title')}
        subtitle={t('insights', 'report.subtitle', { days: formatNumber(view.days) })}
      />

      {/*
        The privacy note is on the page, not buried in a tooltip. It is the honest explanation of why
        the visitor number below is what it is — and a merchant who understands that the platform
        counts without identifying is a merchant who can answer their own customers' questions.
      */}
      <Panel note={t('insights', 'report.privacyNote')}>
        <StateNotice view={view} />

        {view.state === 'ready' ? (
          <dl className="sbd-stats">
            {/*
              THE FIRST TWO CHARTS IN THE PRODUCT — «مرصد» signature element #1.
              (`DESIGN_BRIEF.md`; before this, the platform rendered no data visualisation at all.)

              Only these two Stats get a trend, and the reason is the whole rule: `view.series` is a
              REAL `analytics_daily` series carrying exactly `pageviews` and `visitors` per day, so
              these two totals and these two lines come from one query over one window. The other
              four totals on this row — product views, WhatsApp clicks, add-to-carts, orders — are
              not in that series, and inventing a shape for them would be a chart that lies.
            */}
            <Stat
              label={t('insights', 'report.pageviews')}
              value={formatNumber(view.totals.pageviews)}
              trend={view.series.map((point) => point.pageviews)}
            />
            <Stat
              label={t('insights', 'report.visitors')}
              value={formatNumber(view.totals.visitorDays)}
              // The label alone would overstate it: this is the sum of daily uniques, so a returning
              // customer is counted once per day. Said here rather than left for someone to discover.
              note={t('insights', 'report.visitorsNote')}
              trend={view.series.map((point) => point.visitors)}
            />
            <Stat
              label={t('insights', 'report.productViews')}
              value={formatNumber(view.totals.productViews)}
            />
            <Stat
              label={t('insights', 'report.whatsappClicks')}
              value={formatNumber(view.totals.whatsappClicks)}
            />
            <Stat
              label={t('insights', 'report.addToCarts')}
              value={formatNumber(view.totals.addToCarts)}
            />
            <Stat label={t('insights', 'report.orders')} value={formatNumber(view.totals.orders)} />
          </dl>
        ) : null}
      </Panel>

      {view.state === 'ready' ? (
        <>
          <Panel title={t('insights', 'report.topPages')} note={t('insights', 'report.topPagesNote')}>
            {view.topPages.length === 0 ? (
              <Empty>{t('insights', 'report.noPages')}</Empty>
            ) : (
              <div className="sbd-table-scroll">
                <table className="sbd-table">
                  <caption className="sbd-hint">{t('insights', 'report.topPages')}</caption>
                  <thead>
                    <tr>
                      <th scope="col">{t('insights', 'report.page')}</th>
                      <th scope="col">{t('insights', 'report.pageviews')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {view.topPages.map((page) => (
                      <tr key={page.path}>
                        {/*
                          A ROUTE SHAPE, translated to Arabic — never the raw `/products/:slug`.
                          The stored value comes from a closed set (`ingest.ts`), so every one of them
                          has a name a shop owner recognises; an unlisted value falls back to the
                          shape itself rather than throwing, because a new route is a missing label,
                          not a broken page.
                        */}
                        <th scope="row">{pathLabel(page.path)}</th>
                        <td className="sbd-num">{formatNumber(page.pageviews)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>

          <Panel
            title={t('insights', 'report.sections')}
            note={t('insights', 'report.sectionsNote')}
          >
            {view.sections.length === 0 ? (
              <Empty>{t('insights', 'report.noSections')}</Empty>
            ) : (
              <div className="sbd-table-scroll">
                <table className="sbd-table">
                  <caption className="sbd-hint">{t('insights', 'report.sections')}</caption>
                  <thead>
                    <tr>
                      <th scope="col">{t('insights', 'report.section')}</th>
                      <th scope="col">{t('insights', 'report.views')}</th>
                      <th scope="col">{t('insights', 'report.averageSeconds')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {view.sections.map((section) => (
                      <tr key={section.section}>
                        <th scope="row">{sectionLabel(section.section)}</th>
                        <td className="sbd-num">{formatNumber(section.views)}</td>
                        <td className="sbd-num">
                          {t('insights', 'report.secondsValue', {
                            seconds: seconds(section.averageDwellMs),
                          })}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>

          {/*
            The search panels are gated on their OWN key. `search_insights` also gates the storefront
            box, deliberately as one key: a report about searches nobody can perform is a screen that
            is always empty (src/shared/features.ts).
          */}
          {searchAvailable === true ? (
            <>
              {/*
                ZERO-RESULT SEARCHES COME FIRST, above the popular terms. Position is the whole
                editorial argument: the popular terms tell a merchant what they already sell, and this
                one tells them what to buy. No `danger` tone — a customer looking for something is
                good news, not an error.
              */}
              <Panel
                title={t('insights', 'report.zeroResults')}
                note={t('insights', 'report.zeroResultsNote')}
              >
                {view.zeroResultTerms.length === 0 ? (
                  <Empty>{t('insights', 'report.noZeroResults')}</Empty>
                ) : (
                  <TermTable
                    rows={view.zeroResultTerms}
                    caption={t('insights', 'report.zeroResults')}
                    countLabel={t('insights', 'report.timesMissed')}
                    countOf={(row) => row.zeroResults}
                  />
                )}
              </Panel>

              <Panel title={t('insights', 'report.topTerms')} note={t('insights', 'report.topTermsNote')}>
                {view.topTerms.length === 0 ? (
                  <Empty>{t('insights', 'report.noTerms')}</Empty>
                ) : (
                  <TermTable
                    rows={view.topTerms}
                    caption={t('insights', 'report.topTerms')}
                    countLabel={t('insights', 'report.searches')}
                    countOf={(row) => row.searches}
                  />
                )}
              </Panel>
            </>
          ) : null}
        </>
      ) : null}
    </>
  );
}

/**
 * Four states, four sentences.
 *
 * `src/app/dashboard/analytics/page.tsx` already refuses to collapse "not provisioned", "no data"
 * and "read failed" into "0 visitors", and the reason holds harder here: three of the four are facts
 * about the PLATFORM and only one is a fact about the shop. A merchant told "0 زيارة" when the query
 * timed out goes looking for a marketing problem they do not have.
 */
function StateNotice({ view }: { view: InsightsView }) {
  if (view.state === 'ready') return null;

  const key =
    view.state === 'awaiting_consent'
      ? 'report.awaitingConsent'
      : view.state === 'awaiting_rollup'
        ? 'report.awaitingRollup'
        : 'report.unavailable';

  return (
    <div
      className={view.state === 'unavailable' ? 'sbd-notice sbd-notice--error' : 'sbd-notice sbd-notice--info'}
      role="status"
    >
      {t('insights', key)}
    </div>
  );
}

/**
 * A table of search terms.
 *
 * `{row.term}` IS A TEXT NODE. Search terms are visitor input — a customer can type anything into
 * the box, and this screen shows it back to the shop owner, which is the classic stored-XSS shape
 * (invariant 4 of Phase 9). React escapes a text child; there is no `dangerouslySetInnerHTML`
 * anywhere on this path and there must never be one. The term is also already trimmed,
 * length-capped and normalised at ingest, so what arrives here is bounded as well as escaped.
 *
 * `dir="auto"` on the cell, because the terms genuinely mix scripts: «فستان» beside "Nike 42". With
 * the page's `rtl` forced onto it, a Latin term renders with its digits and punctuation in the wrong
 * place, which on a report about what customers typed is a misquote.
 */
function TermTable({
  rows,
  caption,
  countLabel,
  countOf,
}: {
  rows: TermRow[];
  caption: string;
  countLabel: string;
  countOf: (row: TermRow) => number;
}) {
  return (
    <div className="sbd-table-scroll">
      <table className="sbd-table">
        <caption className="sbd-hint">{caption}</caption>
        <thead>
          <tr>
            <th scope="col">{t('insights', 'report.term')}</th>
            <th scope="col">{countLabel}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.term}>
              <th scope="row" dir="auto">
                {row.term}
              </th>
              <td className="sbd-num">{formatNumber(countOf(row))}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * A stored route shape, in Arabic.
 *
 * The catalogue of shapes is closed (`PATH_RULES` in `src/server/analytics/ingest.ts`), so every
 * value has a label — but `messageExists` is not consulted and the fallback is the shape itself
 * rather than a throw: a route added by a later phase must show up as an unfamiliar line in a
 * report, not as a 500 on the report.
 */
function pathLabel(path: string): string {
  return PATH_LABELS[path] ?? path;
}

const PATH_LABELS: Record<string, string> = {
  '/': t('insights', 'report.paths.home'),
  '/products': t('insights', 'report.paths.products'),
  '/products/:slug': t('insights', 'report.paths.product'),
  '/p/:slug': t('insights', 'report.paths.page'),
  '/cart': t('insights', 'report.paths.cart'),
  '/checkout': t('insights', 'report.paths.checkout'),
  '/search': t('insights', 'report.paths.search'),
  '/order/:code': t('insights', 'report.paths.order'),
  '/offline': t('insights', 'report.paths.offline'),
  '/other': t('insights', 'report.paths.other'),
};

/**
 * A section anchor, in Arabic.
 *
 * The anchors are the platform's own vocabulary (`SECTION_ANCHORS`), and the labels reuse the
 * merchant's word for each block. An anchor with a numeric suffix — `about-2`, the second block of a
 * type on one page — keeps its suffix so two rows are distinguishable, which matters precisely on the
 * pages that have repeats.
 */
function sectionLabel(section: string): string {
  const match = /^(.+?)-(\d{1,2})$/.exec(section);
  const base = match ? match[1]! : section;
  const suffix = match ? ` ${formatNumber(Number(match[2]))}` : '';
  return `${SECTION_LABELS[base] ?? base}${suffix}`;
}

const SECTION_LABELS: Record<string, string> = {
  top: t('insights', 'report.sectionNames.top'),
  products: t('insights', 'report.sectionNames.products'),
  categories: t('insights', 'report.sectionNames.categories'),
  about: t('insights', 'report.sectionNames.about'),
  gallery: t('insights', 'report.sectionNames.gallery'),
  reviews: t('insights', 'report.sectionNames.reviews'),
  offers: t('insights', 'report.sectionNames.offers'),
  contact: t('insights', 'report.sectionNames.contact'),
  location: t('insights', 'report.sectionNames.location'),
  more: t('insights', 'report.sectionNames.more'),
  /**
   * Phase 9's eight new section types. The anchors are the ones this track proposes in
   * `docs/PHASE-9-track-c-handoff.md` — single tokens with no hyphen, matching the style of the ten
   * above, and no hyphen specifically because the occurrence suffix is `-2` and a base name
   * containing one is a needless invitation to a parsing bug.
   *
   * Labelled here in advance so that the report is fully Arabic the day the anchors land. An anchor
   * that is not on this list renders as itself — a Latin word on an Arabic screen, which is the
   * visible reminder to add a label rather than a silent gap.
   */
  banners: t('insights', 'report.sectionNames.banners'),
  trust: t('insights', 'report.sectionNames.trust'),
  hours: t('insights', 'report.sectionNames.hours'),
  stats: t('insights', 'report.sectionNames.stats'),
  new: t('insights', 'report.sectionNames.new'),
  bestsellers: t('insights', 'report.sectionNames.bestsellers'),
  related: t('insights', 'report.sectionNames.related'),
  search: t('insights', 'report.sectionNames.search'),
};
