import Link from 'next/link';
import { consentSummary, listDsrRequests, type DsrRow } from '@/server/admin';
import { DSR_SUBJECT_KINDS } from '@/server/dsr';
import { formatDate, formatDateTime, formatNumber, t } from '@/shared/i18n';
import { param, requireAdminPage } from '../_components/guard';
import { ActionForm } from '../_components/action-form';
import { Empty, PageHead, Panel } from '../_components/ui';
import { findDsrByPhoneAction, updateDsrRequestAction } from './actions';

export const dynamic = 'force-dynamic';

const DSR_STATUSES = ['received', 'in_progress', 'completed', 'rejected'] as const;

/**
 * `admin.{DOMAIN}/privacy` — the two compliance surfaces Phase 6 owes an operator.
 *
 * ONE SCREEN, TWO PANELS, because they are answered together in practice: somebody asking what a
 * shop holds about them, and the log of what that shop's visitors agreed to. Splitting them into
 * two rail entries would put a screen behind a click that is only ever opened for the other one.
 *
 * The DSR queue is a WORK QUEUE — open requests first, and every row carries the status control
 * that moves it along. The consents panel is deliberately NOT a queue and not a list of rows: see
 * `src/server/admin/consents.ts` for why a page of rotating monthly hashes would tell an operator
 * nothing while implying the platform can identify a visitor from it.
 */
export default async function PrivacyPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = await requireAdminPage();
  const query = await searchParams;

  const status = param(query, 'status');
  const subject = param(query, 'subject');
  const ids = (param(query, 'ids') ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  const days = Number(param(query, 'days') ?? '90');

  const [requests, consents] = await Promise.all([
    listDsrRequests(ctx.actor, {
      status: DSR_STATUSES.includes(status as never) ? (status as never) : undefined,
      subjectKind: DSR_SUBJECT_KINDS.includes(subject as never) ? (subject as never) : undefined,
      // Ids resolved by `findDsrByPhoneAction`, never a phone number — see that action.
      ids,
    }),
    consentSummary(ctx, { days: Number.isFinite(days) && days > 0 ? Math.min(days, 365) : 90 }),
  ]);

  const open = requests.filter((row) => row.status === 'received' || row.status === 'in_progress');

  return (
    <>
      <PageHead title={t('admin', 'privacy.title')} subtitle={t('admin', 'privacy.subtitle')} />

      <Panel title={t('admin', 'privacy.dsr.heading')}>
        <p className="sba-hint">
          {t('admin', 'privacy.dsr.pending', { count: formatNumber(open.length) })}
        </p>

        <form className="sba-toolbar" method="get" action="/privacy">
          <div className="sba-field">
            <label className="sba-label" htmlFor="status">
              {t('admin', 'privacy.dsr.filterStatus')}
            </label>
            <select className="sba-select" id="status" name="status" defaultValue={status ?? ''}>
              <option value="">{t('admin', 'accounts.all')}</option>
              {DSR_STATUSES.map((value) => (
                <option key={value} value={value}>
                  {t('admin', `privacy.dsr.statuses.${value}`)}
                </option>
              ))}
            </select>
          </div>

          <div className="sba-field">
            <label className="sba-label" htmlFor="subject">
              {t('admin', 'privacy.dsr.filterSubject')}
            </label>
            <select className="sba-select" id="subject" name="subject" defaultValue={subject ?? ''}>
              <option value="">{t('admin', 'accounts.all')}</option>
              {DSR_SUBJECT_KINDS.map((value) => (
                <option key={value} value={value}>
                  {t('admin', `privacy.dsr.subjects.${value}`)}
                </option>
              ))}
            </select>
          </div>

          <div className="sba-actions">
            <button type="submit" className="sba-btn sba-btn--primary">
              {t('admin', 'accounts.apply')}
            </button>
            <Link className="sba-btn sba-btn--quiet" href="/privacy">
              {t('admin', 'accounts.reset')}
            </Link>
          </div>
        </form>

        {/*
          The phone lookup is its OWN form, and a POST. A GET would put a data subject's plaintext
          number in the URL and the access log; this resolves it to row ids server-side and
          redirects with only those.
        */}
        <ActionForm action={findDsrByPhoneAction} submitLabel={t('admin', 'accounts.apply')}>
          <div className="sba-field">
            <label className="sba-label" htmlFor="phone">
              {t('admin', 'privacy.dsr.filterPhone')}
            </label>
            <input
              className="sba-input"
              id="phone"
              name="phone"
              type="tel"
              dir="ltr"
              aria-describedby="phone-hint"
            />
            <span className="sba-hint" id="phone-hint">
              {t('admin', 'privacy.dsr.filterPhoneHint')}
            </span>
          </div>
        </ActionForm>

        {requests.length === 0 ? (
          <Empty>{t('admin', 'privacy.dsr.empty')}</Empty>
        ) : (
          <ul className="sba-stack">
            {requests.map((row) => (
              <DsrCard key={row.id} row={row} />
            ))}
          </ul>
        )}
      </Panel>

      <Panel title={t('admin', 'privacy.consents.heading')}>
        {/*
          The note is not decoration. An operator looking at a consent log naturally assumes it can
          be traced back to a person; it cannot, the generated privacy policy says so in the same
          words, and a screen that let the assumption stand would be the first thing to contradict
          the document this phase exists to make true.
        */}
        <p className="sba-hint">{t('admin', 'privacy.consents.note')}</p>

        {consents.length === 0 ? (
          <Empty>{t('admin', 'privacy.consents.empty')}</Empty>
        ) : (
          <div className="sba-table-wrap">
            <table className="sba-table">
              <caption className="sba-visually-hidden">
                {t('admin', 'privacy.consents.heading')}
              </caption>
              <thead>
                <tr>
                  <th scope="col">{t('admin', 'privacy.consents.tenant')}</th>
                  <th scope="col">{t('admin', 'privacy.consents.analyticsGranted')}</th>
                  <th scope="col">{t('admin', 'privacy.consents.analyticsDenied')}</th>
                  <th scope="col">{t('admin', 'privacy.consents.pushGranted')}</th>
                  <th scope="col">{t('admin', 'privacy.consents.pushWithdrawn')}</th>
                  <th scope="col">{t('admin', 'privacy.consents.latest')}</th>
                </tr>
              </thead>
              <tbody>
                {consents.map((row) => (
                  <tr key={row.tenantId}>
                    <td>{row.tenantName}</td>
                    <td className="sba-num">{formatNumber(row.analyticsGranted)}</td>
                    <td className="sba-num">{formatNumber(row.analyticsDenied)}</td>
                    <td className="sba-num">{formatNumber(row.pushGranted)}</td>
                    <td className="sba-num">{formatNumber(row.pushWithdrawn)}</td>
                    <td className="sba-num">{row.latestAt ? formatDate(row.latestAt) : '—'}</td>
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

/**
 * One request, with its decision control inline.
 *
 * The subject's email is shown because an operator has to answer it; the phone is shown as a
 * PRESENCE and never as a value, because the value is not stored — only an HMAC is, and rendering
 * that would put a stable per-person identifier into the DOM, the history and any screenshot
 * pasted into a support thread.
 */
function DsrCard({ row }: { row: DsrRow }) {
  return (
    <li className="sba-item">
      <div className="sba-item-head">
        <strong>{t('admin', `privacy.dsr.subjects.${row.subjectKind}`)}</strong>
        <span className="sba-mono">{t('admin', `privacy.dsr.kinds.${row.kind}`)}</span>
        <span className="sba-mono">{formatDateTime(row.receivedAt)}</span>
      </div>

      <dl className="sba-facts sba-payload">
        <div>
          <dt>{t('admin', 'privacy.dsr.subject')}</dt>
          <dd dir={row.subjectEmail ? 'ltr' : undefined}>
            {row.subjectEmail ??
              (row.hasPhone
                ? t('admin', 'privacy.dsr.contactPhone')
                : t('admin', 'privacy.dsr.noContact'))}
          </dd>
        </div>
        {row.tenantRef ? (
          <div>
            <dt>{t('admin', 'privacy.dsr.tenantRef')}</dt>
            <dd>{row.tenantRef}</dd>
          </div>
        ) : null}
        <div>
          <dt>{t('admin', 'privacy.dsr.status')}</dt>
          <dd>{t('admin', `privacy.dsr.statuses.${row.status}`)}</dd>
        </div>
      </dl>

      {row.details ? <p className="sba-hint">{row.details}</p> : null}
      {row.resolution ? (
        <p>
          <strong>{t('admin', 'privacy.dsr.resolution')}: </strong>
          {row.resolution}
        </p>
      ) : null}

      <ActionForm action={updateDsrRequestAction} submitLabel={t('admin', 'privacy.dsr.apply')}>
        <input type="hidden" name="id" value={row.id} />

        <div className="sba-field">
          <label className="sba-label" htmlFor={`status-${row.id}`}>
            {t('admin', 'privacy.dsr.status')}
          </label>
          <select
            className="sba-select"
            id={`status-${row.id}`}
            name="status"
            defaultValue={row.status}
          >
            {DSR_STATUSES.map((value) => (
              <option key={value} value={value}>
                {t('admin', `privacy.dsr.statuses.${value}`)}
              </option>
            ))}
          </select>
        </div>

        <div className="sba-field">
          <label className="sba-label" htmlFor={`resolution-${row.id}`}>
            {t('admin', 'privacy.dsr.resolutionLabel')}
          </label>
          <textarea
            className="sba-input"
            id={`resolution-${row.id}`}
            name="resolution"
            rows={2}
            maxLength={2000}
            defaultValue={row.resolution ?? ''}
          />
        </div>
      </ActionForm>
    </li>
  );
}

