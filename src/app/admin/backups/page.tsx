import { loadBackups, type BackupRound } from '@/server/admin';
import { formatDateTime, formatNumber, t } from '@/shared/i18n';
import { param, requireAdminPage } from '../_components/guard';
import { Empty, Notice, PageHead, Panel, StatusTag } from '../_components/ui';
import { downloadBackupAction, requestBackupRunAction } from './actions';

export const dynamic = 'force-dynamic';

/**
 * «النسخ الاحتياطية» — the platform's own dumps, for the platform owner only (Q23, Q26).
 *
 * This screen answers ONE question — "if the server died right now, what would we get back, and
 * from when?" — and everything on it exists to answer it faster than a container log would:
 *
 *   - the LAST GOOD round and its age, in red when it is older than the schedule we publish;
 *   - every round in the retention window, with each database's size, because a dump that suddenly
 *     halved in size is the failure that reports success;
 *   - the lifecycle-rule state, because "retained 14 days" is published in every tenant's Arabic
 *     privacy policy and the script can only CHECK the rule, never install it;
 *   - a run-now button and a download.
 *
 * The interval and retention are shown READ-ONLY on purpose. Both are interpolated into every
 * tenant's privacy policy by `src/server/legal/facts.ts`, so an editable field here would let an
 * operator make a published legal claim false from a screen that says nothing about legal claims.
 * They change in `.env` and the compliance sync follows.
 */
export default async function BackupsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireAdminPage();
  const params = await searchParams;
  const view = await loadBackups();

  return (
    <>
      <PageHead title={t('admin', 'backups.title')} subtitle={t('admin', 'backups.subtitle')} />

      <Notice okKey={param(params, 'ok')} errorKey={param(params, 'error')} />

      {!view.configured ? (
        <Panel title={t('admin', 'backups.notConfigured.title')}>
          <p className="sba-hint">{t('admin', 'backups.notConfigured.body')}</p>
        </Panel>
      ) : (
        <>
          <Panel
            title={t('admin', 'backups.status.title')}
            actions={
              <form action={requestBackupRunAction}>
                <button
                  type="submit"
                  className="sba-btn sba-btn--primary"
                  disabled={view.runPending}
                >
                  {t('admin', view.runPending ? 'backups.runPending' : 'backups.runNow')}
                </button>
              </form>
            }
          >
            {view.lastGood ? (
              <div className={view.stale ? 'sba-notice sba-notice--error' : 'sba-notice sba-notice--ok'}>
                <p>
                  {t('admin', 'backups.status.lastGood', {
                    date: formatDateTime(new Date(view.lastGood.restorePoint)),
                    hours: formatNumber(view.lastGood.ageHours),
                  })}
                </p>
                {view.stale ? (
                  <p className="sba-hint">
                    {t('admin', 'backups.status.stale', {
                      hours: formatNumber(view.intervalHours),
                    })}
                  </p>
                ) : null}
              </div>
            ) : (
              <div className="sba-notice sba-notice--error" role="alert">
                <p>{t('admin', 'backups.status.none')}</p>
              </div>
            )}

            <dl className="sba-facts">
              <div>
                <dt>{t('admin', 'backups.status.interval')}</dt>
                <dd>{t('admin', 'backups.status.everyHours', { hours: formatNumber(view.intervalHours) })}</dd>
              </div>
              <div>
                <dt>{t('admin', 'backups.status.retention')}</dt>
                <dd>{t('admin', 'backups.status.days', { days: formatNumber(view.retentionDays) })}</dd>
              </div>
              {view.status ? (
                <div>
                  <dt>{t('admin', 'backups.status.lastRun')}</dt>
                  <dd>{formatDateTime(new Date(view.status.finishedAt))}</dd>
                </div>
              ) : null}
            </dl>

            {/* The published numbers are facts in a legal document, not settings — see the file's
                own comment. Saying so on screen is what stops the next operator looking for the
                edit button that is deliberately absent. */}
            <p className="sba-hint">{t('admin', 'backups.status.policyNote')}</p>

            {view.lifecycleWarning ? (
              <div className="sba-notice sba-notice--error" role="alert">
                <p>{t('admin', `backups.lifecycle.${view.lifecycleWarning}`)}</p>
                <p className="sba-hint">
                  {t('admin', 'backups.lifecycle.fix', { days: formatNumber(view.retentionDays) })}
                </p>
              </div>
            ) : null}
          </Panel>

          <Panel title={t('admin', 'backups.rounds.title')} note={t('admin', 'backups.rounds.note')}>
            {view.rounds.length === 0 ? (
              <Empty>{t('admin', 'backups.rounds.empty')}</Empty>
            ) : (
              <div className="sba-table-wrap">
                <table className="sba-table">
                  <caption className="sba-visually-hidden">{t('admin', 'backups.rounds.title')}</caption>
                  <thead>
                    <tr>
                      <th scope="col">{t('admin', 'backups.rounds.columns.takenAt')}</th>
                      <th scope="col">{t('admin', 'backups.rounds.columns.databases')}</th>
                      <th scope="col">{t('admin', 'backups.rounds.columns.size')}</th>
                      <th scope="col">{t('admin', 'backups.rounds.columns.state')}</th>
                      <th scope="col">{t('admin', 'backups.rounds.columns.download')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {view.rounds.map((round) => (
                      <RoundRow key={round.manifestKey} round={round} />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>
        </>
      )}

      {/*
        The runbook, rendered rather than linked-and-forgotten. A restore is not a button here
        (Q23), so the steps have to be reachable from the screen an operator opens when they need
        them — at 3am, on a phone, from a hotel.
      */}
      <Panel title={t('admin', 'backups.restore.title')} note={t('admin', 'backups.restore.note')}>
        <ol>
          {['capture', 'list', 'show', 'into', 'verify', 'replay', 'record'].map((step) => (
            <li key={step}>{t('admin', `backups.restore.steps.${step}`)}</li>
          ))}
        </ol>
        <p className="sba-hint">{t('admin', 'backups.restore.identity')}</p>
      </Panel>
    </>
  );
}

function megabytes(bytes: number): string {
  return formatNumber(Math.max(1, Math.round(bytes / 1_048_576)));
}

function RoundRow({ round }: { round: BackupRound }) {
  const total = round.databases.reduce((sum, db) => sum + (db.encryptedBytes || 0), 0);

  return (
    <tr>
      <th scope="row" className="sba-num">
        {round.restorePoint ? formatDateTime(new Date(round.restorePoint)) : '—'}
        <span className="sba-hint sba-mono">{round.stamp}</span>
      </th>
      <td>
        {round.databases.length === 0 ? (
          <span className="sba-hint">{t('admin', 'backups.rounds.unreadable')}</span>
        ) : (
          <div className="sba-actions">
            {round.databases.map((db) => (
              <span className="sba-chip" key={db.key}>
                {db.database}
              </span>
            ))}
          </div>
        )}
      </td>
      <td className="sba-num">
        {total > 0 ? t('admin', 'backups.rounds.megabytes', { size: megabytes(total) }) : '—'}
      </td>
      <td>
        <StatusTag
          status={round.ok ? 'active' : 'suspended'}
          label={t('admin', round.ok ? 'backups.rounds.ok' : 'backups.rounds.failed')}
        />
      </td>
      <td>
        <div className="sba-stack">
          {round.databases.map((db) => (
            <form action={downloadBackupAction} key={db.key}>
              <input type="hidden" name="key" value={db.key} />
              <button type="submit" className="sba-btn sba-btn--sm">
                {t('admin', 'backups.rounds.downloadOne', { database: db.database })}
              </button>
            </form>
          ))}
        </div>
      </td>
    </tr>
  );
}
