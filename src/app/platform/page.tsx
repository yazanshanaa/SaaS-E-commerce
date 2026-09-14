import { getEnv } from '@/env';
import { publicDb } from '@/server/db';
import { logger } from '@/server/logger';
import { formatAgorot, formatNumber, t } from '@/shared/i18n';

export const dynamic = 'force-dynamic';

const pt = (key: string, params?: Record<string, string | number>) => t('common', `platform.${key}`, params);

interface PlanCard {
  key: string;
  name: string;
  description: string;
  priceMonthlyAgorot: number;
  priceYearlyAgorot: number;
  setupFeeAgorot: number;
  productsLimit: number | null;
}

/**
 * The public plan list. Read through the public actor — `plans` is a global table, and the page
 * shows nothing that the admin has hidden. A database hiccup on the marketing page must not take
 * the page down: the section degrades to a contact line.
 */
async function loadPlans(): Promise<PlanCard[]> {
  try {
    const rows = await publicDb().plan.findMany({
      where: { active: true, hidden: false, NOT: { key: 'demo' } },
      orderBy: { sortOrder: 'asc' },
      select: {
        key: true,
        name: true,
        description: true,
        priceMonthlyAgorot: true,
        priceYearlyAgorot: true,
        setupFeeAgorot: true,
        features: { where: { featureKey: 'products_limit' }, select: { value: true } },
      },
    });
    return rows
      .filter((row) => row.priceMonthlyAgorot > 0)
      .map((row) => ({
        key: row.key,
        name: row.name,
        description: row.description ?? '',
        priceMonthlyAgorot: row.priceMonthlyAgorot,
        priceYearlyAgorot: row.priceYearlyAgorot,
        setupFeeAgorot: row.setupFeeAgorot,
        productsLimit:
          typeof row.features[0]?.value === 'number' ? (row.features[0].value as number) : null,
      }));
  } catch (error) {
    logger().warn({ err: error }, 'platform page could not load plans');
    return [];
  }
}

export default async function PlatformHomePage() {
  const env = getEnv();
  const appOrigin = `${env.PUBLIC_SCHEME}://${env.APP_HOST_PREFIX}.${env.DOMAIN}`;
  const adminOrigin = `${env.PUBLIC_SCHEME}://${env.ADMIN_HOST_PREFIX}.${env.DOMAIN}`;
  const demoHref = `${appOrigin}/demo-request`;
  const plans = await loadPlans();
  const year = new Date().getFullYear();

  return (
    <>
      <header className="pf-top">
        <div className="pf-shell pf-top__inner">
          <a className="pf-brand" href="/">
            <span className="pf-brand__mark" aria-hidden="true" />
            {t('common', 'app.name')}
          </a>
          <nav className="pf-top__nav" aria-label={t('common', 'platform.nav.plans')}>
            <a href="#how">{pt('nav.how')}</a>
            <a href="#plans">{pt('nav.plans')}</a>
            <a href="#faq">{pt('nav.faq')}</a>
          </nav>
          <div className="pf-top__actions">
            <a className="pf-btn pf-btn--ghost" href={appOrigin}>
              {pt('nav.signIn')}
            </a>
            <a className="pf-btn" href={demoHref}>
              {pt('nav.demo')}
            </a>
          </div>
        </div>
      </header>

      <main id="main">
        {/* ------------------------------------------------------------ hero -- */}
        <section className="pf-hero">
          <div className="pf-shell pf-hero__inner">
            <div className="pf-hero__copy">
              <p className="pf-eyebrow">{pt('hero.eyebrow')}</p>
              <h1 className="pf-hero__title">{pt('hero.title')}</h1>
              <p className="pf-hero__lead">{pt('hero.lead')}</p>
              <div className="pf-actions">
                <a className="pf-btn pf-btn--lg" href={demoHref}>
                  {pt('hero.primary')}
                </a>
                <a className="pf-btn pf-btn--ghost pf-btn--lg" href="#plans">
                  {pt('hero.secondary')}
                </a>
              </div>
              <ul className="pf-proof">
                <li>{pt('hero.proof1')}</li>
                <li>{pt('hero.proof2')}</li>
                <li>{pt('hero.proof3')}</li>
              </ul>
            </div>

            {/* A store, drawn in CSS: the shape every visitor recognises before reading a word. */}
            <div className="pf-mock" aria-hidden="true">
              <div className="pf-mock__bar">
                <span className="pf-mock__brand">{pt('mock.shop')}</span>
                <span className="pf-mock__search" />
                <span className="pf-mock__cart">3</span>
              </div>
              <div className="pf-mock__cats">
                <span data-on="true">{pt('mock.cat1')}</span>
                <span>{pt('mock.cat2')}</span>
                <span>{pt('mock.cat3')}</span>
                <span>{pt('mock.cat4')}</span>
              </div>
              <div className="pf-mock__grid">
                {(['p1', 'p2', 'p3', 'p4'] as const).map((key, index) => (
                  <div className="pf-mock__card" key={key} data-i={index}>
                    <span className="pf-mock__img" />
                    <span className="pf-mock__name">{pt(`mock.${key}`)}</span>
                    <span className="pf-mock__price">{formatAgorot(4900 + index * 3000)}</span>
                    <span className="pf-mock__buy">{pt('mock.buy')}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>

        {/* ------------------------------------------------------------- how -- */}
        <section className="pf-section" id="how">
          <div className="pf-shell">
            <h2 className="pf-h2">{pt('how.title')}</h2>
            <ol className="pf-steps">
              {(['s1', 's2', 's3'] as const).map((step, index) => (
                <li className="pf-step" key={step}>
                  <span className="pf-step__n">{formatNumber(index + 1)}</span>
                  <h3>{pt(`how.${step}t`)}</h3>
                  <p>{pt(`how.${step}b`)}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        {/* -------------------------------------------------------- features -- */}
        <section className="pf-section pf-section--deep">
          <div className="pf-shell">
            <h2 className="pf-h2">{pt('features.title')}</h2>
            <dl className="pf-features">
              {(['f1', 'f2', 'f3', 'f4', 'f5', 'f6'] as const).map((key) => (
                <div className="pf-feature" key={key}>
                  <dt>{pt(`features.${key}t`)}</dt>
                  <dd>{pt(`features.${key}b`)}</dd>
                </div>
              ))}
            </dl>
          </div>
        </section>

        {/* ----------------------------------------------------------- plans -- */}
        <section className="pf-section" id="plans">
          <div className="pf-shell">
            <h2 className="pf-h2">{pt('plans.title')}</h2>
            <p className="pf-lead">{pt('plans.lead')}</p>
            {plans.length === 0 ? (
              <p className="pf-lead">{pt('plans.empty')}</p>
            ) : (
              <div className="pf-plans">
                {plans.map((plan, index) => (
                  <article className="pf-plan" key={plan.key} data-featured={index === 1 ? 'true' : undefined}>
                    <h3 className="pf-plan__name">{plan.name}</h3>
                    <p className="pf-plan__desc">{plan.description}</p>
                    <p className="pf-plan__price">
                      <strong>{formatAgorot(plan.priceMonthlyAgorot)}</strong>
                      <span>{pt('plans.monthly')}</span>
                    </p>
                    <ul className="pf-plan__facts">
                      <li>
                        {formatAgorot(plan.priceYearlyAgorot)} {pt('plans.yearly')}
                      </li>
                      {plan.setupFeeAgorot > 0 ? (
                        <li>
                          {pt('plans.setup')}: {formatAgorot(plan.setupFeeAgorot)}
                        </li>
                      ) : null}
                      <li>
                        {plan.productsLimit
                          ? pt('plans.products', { count: formatNumber(plan.productsLimit) })
                          : pt('plans.productsUnlimited')}
                      </li>
                    </ul>
                    <a className="pf-btn pf-btn--full" href={demoHref}>
                      {pt('plans.choose')}
                    </a>
                  </article>
                ))}
              </div>
            )}
          </div>
        </section>

        {/* ------------------------------------------------------------- faq -- */}
        <section className="pf-section pf-section--deep" id="faq">
          <div className="pf-shell pf-shell--read">
            <h2 className="pf-h2">{pt('faq.title')}</h2>
            <div className="pf-faq">
              {(['q1', 'q2', 'q3', 'q4'] as const).map((key) => (
                <details className="pf-faq__item" key={key}>
                  <summary>{pt(`faq.${key}`)}</summary>
                  <p>{pt(`faq.a${key.slice(1)}`)}</p>
                </details>
              ))}
            </div>
          </div>
        </section>

        {/* ------------------------------------------------------------- cta -- */}
        <section className="pf-section pf-cta">
          <div className="pf-shell pf-shell--read">
            <h2 className="pf-h2">{pt('cta.title')}</h2>
            <p className="pf-lead">{pt('cta.lead')}</p>
            <a className="pf-btn pf-btn--lg" href={demoHref}>
              {pt('cta.button')}
            </a>
          </div>
        </section>
      </main>

      <footer className="pf-footer">
        <div className="pf-shell pf-footer__inner">
          <span>
            © {String(year)} {t('common', 'app.name')} — {pt('footer.rights')}
          </span>
          <nav aria-label={pt('footer.merchants')}>
            <a href={appOrigin}>{pt('footer.merchants')}</a>
            <a href={adminOrigin}>{pt('footer.admin')}</a>
          </nav>
        </div>
      </footer>
    </>
  );
}
