import Link from 'next/link';
import { notFound } from 'next/navigation';
import { listPlans } from '@/server/admin';
import { getDemo } from '@/server/demo/admin';
import { jerusalemDateKey } from '@/server/time';
import { formatDate, formatNumber, t } from '@/shared/i18n';
import { param, requireAdminPage } from '../../_components/guard';
import { BackLink, Field, Notice, PageHead, Panel, Select, TextInput } from '../../_components/ui';
import { closeDemoAction, convertDemoAction, setDemoExpiryAction } from '../actions';
import { DemoAge, DemoLinkCell, packLabel } from '../_components/shell';

export const dynamic = 'force-dynamic';

/**
 * One demo: what is in it, and the three things that can be done to it.
 *
 * The three actions are deliberately on one screen and in this order — expiry, convert, close —
 * because that is the order of a sales conversation: hold the link open, win the account, or let
 * it go. Only the last is irreversible, and it is the only one behind a typed confirmation.
 *
 * `mediaPending` is on the page for one reason: it answers "is it ready to send?". Variants are
 * produced by A3's queue AFTER the demo commits, so for the first few seconds the shop exists with
 * images that have no renderable size yet. An operator who sends the link in that window gets a
 * question they cannot answer.
 */
export default async function DemoDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ tenantId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = await requireAdminPage();
  const { tenantId } = await params;
  const query = await searchParams;

  const demo = await getDemo(ctx.actor, tenantId);
  if (!demo) notFound();

  // A demo can only be converted onto a plan that is actually for sale: `convertDemo` refuses a
  // hidden or inactive one, so offering it here would be an option that always fails.
  const plans = (await listPlans(ctx)).filter((plan) => !plan.hidden && plan.active);

  return (
    <>
      <PageHead
        title={demo.name}
        subtitle={demo.slug}
        actions={<BackLink href="/demos" label={t('demo', 'admin.detail.back')} />}
      />

      <Notice okKey={param(query, 'ok')} errorKey={param(query, 'error')} />

      <Panel title={t('demo', 'admin.detail.content')}>
        <dl className="sba-kv">
          <div>
            <dt>{t('demo', 'admin.list.columns.template')}</dt>
            <dd>{demo.templateName}</dd>
          </div>
          <div>
            <dt>{t('demo', 'admin.create.pack')}</dt>
            <dd>{packLabel(demo.packKey)}</dd>
          </div>
          <div>
            <dt>{t('demo', 'admin.list.columns.age')}</dt>
            <dd>
              <DemoAge days={demo.ageDays} />
              <span className="sba-hint">{formatDate(demo.createdAt)}</span>
            </dd>
          </div>
          <div>
            <dt>{t('demo', 'admin.list.columns.products')}</dt>
            <dd className="sba-num">{formatNumber(demo.productCount)}</dd>
          </div>
          <div>
            <dt>{t('demo', 'admin.detail.categories')}</dt>
            <dd className="sba-num">{formatNumber(demo.categoryCount)}</dd>
          </div>
          <div>
            <dt>{t('demo', 'admin.detail.sections')}</dt>
            <dd className="sba-num">{formatNumber(demo.sectionCount)}</dd>
          </div>
          <div>
            <dt>{t('demo', 'admin.detail.testimonials')}</dt>
            <dd className="sba-num">{formatNumber(demo.testimonialCount)}</dd>
          </div>
          <div>
            <dt>{t('demo', 'admin.detail.images')}</dt>
            <dd>
              {t('demo', 'admin.detail.imagesReady', { count: formatNumber(demo.mediaReady) })}
              {demo.mediaPending > 0
                ? ` · ${t('demo', 'admin.detail.imagesPending', {
                    count: formatNumber(demo.mediaPending),
                  })}`
                : ''}
            </dd>
          </div>
          <div>
            <dt>{t('demo', 'admin.list.columns.link')}</dt>
            <dd>
              <DemoLinkCell url={demo.demoUrl} expiresAt={demo.tokenExpiresAt} />
            </dd>
          </div>
          {demo.requesterWhatsapp ? (
            <div>
              <dt>{t('demo', 'admin.detail.requester')}</dt>
              <dd>
                <a
                  className="sba-btn sba-btn--sm"
                  href={`https://wa.me/${demo.requesterWhatsapp.replace(/\D/g, '')}`}
                  rel="noreferrer noopener"
                  target="_blank"
                >
                  {t('demo', 'admin.requests.columns.contact')}
                </a>
              </dd>
            </div>
          ) : null}
        </dl>

        <div className="sba-actions">
          <Link className="sba-btn sba-btn--sm" href={`/accounts/${demo.tenantId}`}>
            {t('demo', 'admin.list.openAccount')}
          </Link>
        </div>
      </Panel>

      <Panel title={t('demo', 'admin.expiry.title')} note={t('demo', 'admin.expiry.note')}>
        <form action={setDemoExpiryAction} className="sba-form">
          <input type="hidden" name="tenantId" value={demo.tenantId} />
          <Field label={t('demo', 'admin.expiry.field')} name="expiresAt">
            {/*
              Rendered in Asia/Jerusalem, because that is how it will be read back.
              `setDemoExpiryAction` parses this field with `parseJerusalemInput`, so filling it from
              `toISOString()` — which is UTC — hands the form a date that is one day earlier for any
              expiry set in the evening, and saving it again walks the link's lifetime backwards a
              day at a time. Same convention as every other date input in the panel.
            */}
            <TextInput
              name="expiresAt"
              type="date"
              defaultValue={demo.tokenExpiresAt ? jerusalemDateKey(demo.tokenExpiresAt) : undefined}
            />
          </Field>
          <div className="sba-actions">
            <button type="submit" className="sba-btn sba-btn--primary">
              {t('demo', 'admin.expiry.submit')}
            </button>
          </div>
        </form>
      </Panel>

      <Panel title={t('demo', 'admin.convert.title')} note={t('demo', 'admin.convert.note')}>
        <form action={convertDemoAction} className="sba-form">
          <input type="hidden" name="tenantId" value={demo.tenantId} />

          <Field label={t('demo', 'admin.convert.plan')} name="planKey">
            <Select
              name="planKey"
              options={plans.map((plan) => ({ value: plan.key, label: plan.name }))}
            />
          </Field>

          <Field label={t('demo', 'admin.convert.period')} name="billingPeriod">
            <Select
              name="billingPeriod"
              options={[
                { value: 'monthly', label: t('demo', 'admin.convert.periodMonthly') },
                { value: 'yearly', label: t('demo', 'admin.convert.periodYearly') },
              ]}
            />
          </Field>

          <Field label={t('demo', 'admin.convert.endsAt')} name="currentPeriodEnd">
            <TextInput name="currentPeriodEnd" type="date" required />
          </Field>

          <div className="sba-actions">
            <button type="submit" className="sba-btn sba-btn--primary">
              {t('demo', 'admin.convert.submit')}
            </button>
          </div>
        </form>
      </Panel>

      <Panel title={t('demo', 'admin.close.title')} note={t('demo', 'admin.close.note')} tone="danger">
        <form action={closeDemoAction} className="sba-form">
          <input type="hidden" name="tenantId" value={demo.tenantId} />
          <Field
            label={t('demo', 'admin.close.confirm')}
            name="confirmSlug"
            hint={t('demo', 'admin.close.confirmHint', { slug: demo.slug })}
          >
            <TextInput name="confirmSlug" placeholder={demo.slug} />
          </Field>
          <div className="sba-actions">
            <button type="submit" className="sba-btn sba-btn--danger">
              {t('demo', 'admin.close.submit')}
            </button>
          </div>
        </form>
      </Panel>
    </>
  );
}
