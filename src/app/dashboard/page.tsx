import Link from 'next/link';
import { formatNumber, t } from '@/shared/i18n';
import { optionalMerchantContext } from './_lib/context';
import { loadOverview } from './_lib/overview';
import { MerchantSignInForm } from './_components/auth-forms';
import { Empty, PageHead, Panel, Stat, Tag } from './_components/ui';

/**
 * `app.{DOMAIN}/` — the sign-in card, or the shop's own front page.
 *
 * The two live on one route on purpose: the shared hostname-resolution e2e asserts that the app
 * root never moves, and a merchant who bookmarks their dashboard should land on a sign-in form
 * at the same URL rather than being bounced somewhere else and back.
 */
export const dynamic = 'force-dynamic';

export default async function DashboardHomePage() {
  const ctx = await optionalMerchantContext();
  if (!ctx) return <MerchantSignInForm />;

  const overview = await loadOverview(ctx);
  if (!overview) return <Empty>{t('common', 'states.empty')}</Empty>;

  const { stats } = overview;
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
