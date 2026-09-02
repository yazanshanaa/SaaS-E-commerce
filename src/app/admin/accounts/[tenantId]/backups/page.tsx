import { getAccount, listTenantBackups, type TenantBackupRow } from '@/server/admin';
import { formatDateTime, formatNumber, t } from '@/shared/i18n';
import { param, requireAdminPage } from '../../../_components/guard';
import { Empty, Field, Notice, Panel, StatusTag, TextInput } from '../../../_components/ui';
import {
  createBackupAction,
  createStandaloneExportAction,
  deleteBackupAction,
  downloadBackupArtifactAction,
  restoreBackupAction,
} from './actions';

export const dynamic = 'force-dynamic';

/**
 * «النسخ» — one shop's backups, and the button that hands the whole shop to somebody else (Q26).
 *
 * Two panels because they are two different decisions:
 *
 *   A BACKUP is reversible and routine. Take one before a risky change, restore it if the change
 *   was wrong. It stays on this platform and only this operator can see it.
 *
 *   A STANDALONE EXPORT leaves. It packs the platform's own source alongside the shop's data so
 *   the result runs on somebody else's server forever. That is a commercial act, not an
 *   operational one, and putting it in its own panel with its own explanation is how the screen
 *   says so.
 *
 * WHAT A RESTORE DOES NOT TOUCH is written on the screen, not just in the code: subscription,
 * payments, gateway credentials and the audit history all survive it (invariant 5, and
 * `tenant-backup/tables.ts` gives the reason per table). An operator who believes a restore rewinds
 * everything would use it to undo a billing mistake, and be wrong in an expensive direction.
 */
export default async function AccountBackupsPage({
  params,
  searchParams,
}: {
  params: Promise<{ tenantId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { tenantId } = await params;
  const ctx = await requireAdminPage();
  const query = await searchParams;

  const [account, rows] = await Promise.all([
    getAccount(ctx, tenantId),
    listTenantBackups(ctx.actor, tenantId),
  ]);

  const slug = account?.slug ?? '';
  const restorable = rows.filter((row) => row.status === 'ready' && row.restorable && row.kind === 'backup');

  return (
    <>
      <Notice okKey={param(query, 'ok')} errorKey={param(query, 'error')} />

      <Panel title={t('admin', 'accountBackups.create.title')} note={t('admin', 'accountBackups.create.note')}>
        <form action={createBackupAction} className="sba-form">
          <input type="hidden" name="tenantId" value={tenantId} />
          <Field
            label={t('admin', 'accountBackups.create.noteLabel')}
            name="note"
            hint={t('admin', 'accountBackups.create.noteHint')}
          >
            <TextInput name="note" />
          </Field>
          <div className="sba-actions">
            <button type="submit" className="sba-btn sba-btn--primary">
              {t('admin', 'accountBackups.create.submit')}
            </button>
          </div>
        </form>
      </Panel>

      <Panel title={t('admin', 'accountBackups.list.title')}>
        {rows.length === 0 ? (
          <Empty>{t('admin', 'accountBackups.list.empty')}</Empty>
        ) : (
          <div className="sba-table-wrap">
            <table className="sba-table">
              <caption className="sba-visually-hidden">{t('admin', 'accountBackups.list.title')}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('admin', 'accountBackups.list.columns.takenAt')}</th>
                  <th scope="col">{t('admin', 'accountBackups.list.columns.kind')}</th>
                  <th scope="col">{t('admin', 'accountBackups.list.columns.contents')}</th>
                  <th scope="col">{t('admin', 'accountBackups.list.columns.size')}</th>
                  <th scope="col">{t('admin', 'accountBackups.list.columns.state')}</th>
                  <th scope="col">{t('admin', 'accountBackups.list.columns.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <BackupRowView key={row.id} row={row} tenantId={tenantId} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {restorable.length > 0 ? (
        <Panel
          tone="danger"
          title={t('admin', 'accountBackups.restore.title')}
          note={t('admin', 'accountBackups.restore.note')}
        >
          <ul className="sba-panel-note">
            {['keeps', 'replaces', 'pauses'].map((line) => (
              <li key={line}>{t('admin', `accountBackups.restore.${line}`)}</li>
            ))}
          </ul>

          <form action={restoreBackupAction} className="sba-form">
            <input type="hidden" name="tenantId" value={tenantId} />

            <Field label={t('admin', 'accountBackups.restore.pick')} name="backupId">
              <select className="sba-select" name="backupId" required>
                {restorable.map((row) => (
                  <option key={row.id} value={row.id}>
                    {formatDateTime(row.createdAt)}
                    {row.note ? ` — ${row.note}` : ''}
                  </option>
                ))}
              </select>
            </Field>

            <Field
              label={t('admin', 'accountBackups.restore.confirmLabel', { slug })}
              name="confirmSlug"
              hint={t('admin', 'accountBackups.restore.confirmHint')}
            >
              <TextInput name="confirmSlug" required />
            </Field>

            <div className="sba-actions">
              <button type="submit" className="sba-btn sba-btn--danger">
                {t('admin', 'accountBackups.restore.submit')}
              </button>
            </div>
          </form>
        </Panel>
      ) : null}

      <Panel
        title={t('admin', 'accountBackups.standalone.title')}
        note={t('admin', 'accountBackups.standalone.note')}
      >
        <ul className="sba-panel-note">
          {['contains', 'features', 'responsibility'].map((line) => (
            <li key={line}>{t('admin', `accountBackups.standalone.${line}`)}</li>
          ))}
        </ul>

        <form action={createStandaloneExportAction} className="sba-form">
          <input type="hidden" name="tenantId" value={tenantId} />
          <Field
            label={t('admin', 'accountBackups.create.noteLabel')}
            name="note"
            hint={t('admin', 'accountBackups.standalone.noteHint')}
          >
            <TextInput name="note" />
          </Field>
          <div className="sba-actions">
            <button type="submit" className="sba-btn">
              {t('admin', 'accountBackups.standalone.submit')}
            </button>
          </div>
        </form>
      </Panel>
    </>
  );
}

function megabytes(bytes: number | null): string {
  if (!bytes) return '—';
  return t('admin', 'accountBackups.list.megabytes', {
    size: formatNumber(Math.max(1, Math.round(bytes / 1_048_576))),
  });
}

function BackupRowView({ row, tenantId }: { row: TenantBackupRow; tenantId: string }) {
  // Reusing the account status vocabulary rather than inventing a palette: `active` is the green
  // the operator already reads as "fine" everywhere else on this surface.
  const tone = row.status === 'ready' ? 'active' : row.status === 'failed' ? 'suspended' : 'demo';

  return (
    <tr>
      <th scope="row" className="sba-num">
        {formatDateTime(row.createdAt)}
        {row.note ? <span className="sba-hint">{row.note}</span> : null}
      </th>
      <td>{t('admin', `accountBackups.kinds.${row.kind}`)}</td>
      <td>
        {row.contents ? (
          <span className="sba-hint">
            {t('admin', 'accountBackups.list.summary', {
              products: formatNumber(row.contents.tables.products ?? 0),
              orders: formatNumber(row.contents.tables.orders ?? 0),
              images: formatNumber(row.contents.mediaFiles),
            })}
            {/* Omissions are stated, never rounded away — the whole point of counting them. */}
            {row.contents.mediaOmitted > 0
              ? ` · ${t('admin', 'accountBackups.list.omitted', {
                  count: formatNumber(row.contents.mediaOmitted),
                })}`
              : ''}
          </span>
        ) : (
          '—'
        )}
      </td>
      <td className="sba-num">{megabytes(row.sizeBytes)}</td>
      <td>
        <StatusTag status={tone} label={t('admin', `accountBackups.states.${row.status}`)} />
        {row.error ? <span className="sba-hint sba-mono">{row.error}</span> : null}
        {row.status === 'ready' && !row.restorable ? (
          <span className="sba-hint">{t('admin', 'accountBackups.list.oldSchema')}</span>
        ) : null}
      </td>
      <td>
        <div className="sba-stack">
          {row.status === 'ready' ? (
            <form action={downloadBackupArtifactAction}>
              <input type="hidden" name="tenantId" value={tenantId} />
              <input type="hidden" name="backupId" value={row.id} />
              <button type="submit" className="sba-btn sba-btn--sm">
                {t('admin', 'accountBackups.list.download')}
              </button>
            </form>
          ) : null}

          {row.status !== 'restoring' ? (
            <form action={deleteBackupAction}>
              <input type="hidden" name="tenantId" value={tenantId} />
              <input type="hidden" name="backupId" value={row.id} />
              <button type="submit" className="sba-btn sba-btn--sm sba-btn--quiet">
                {t('admin', 'accountBackups.list.delete')}
              </button>
            </form>
          ) : null}
        </div>
      </td>
    </tr>
  );
}
