import { dispatchJob } from '@/server/billing/dispatch';
import { superAdminDb, type Actor } from '@/server/db';
import { BACKUP_JOBS } from '@/server/jobs/contract';
import { logger } from '@/server/logger';
import { mediaStorage } from '@/server/media/storage';
import { systemJob, tenantJob } from '@/server/queues';
import { MAX_SIGNED_URL_TTL_SECONDS } from '@/server/storage';
import { getEnv } from '@/env';
import { CURRENT_SCHEMA_VERSION } from './schema-version';
import { BackupError, type BackupContents } from './types';

/**
 * The OWNER-FACING half of per-tenant backups (Q24, Q26).
 *
 * Everything here runs as a verified super admin — `superAdminDb(actor)` re-checks the role rather
 * than trusting its caller, exactly as `src/server/admin` does — and there is no merchant path into
 * any of it: no feature key, no capability, no dashboard route. A tenant backup is an operator's
 * tool, and one a merchant could trigger would be a way to have the platform archive a shop's data
 * on demand, which is a different product with different promises.
 *
 * THE WORK IS ALWAYS A JOB. Creating a backup reads every table and every image; restoring one
 * rewrites both. Neither belongs in a request thread — a server action that took four minutes
 * would be a proxy timeout on the operator's side and an uninterruptible write on the platform's.
 * So these functions write a row, enqueue, and return; the screen shows the row's status.
 *
 * THE ROW IS WRITTEN BEFORE THE ENQUEUE, deliberately. A row with no job is visible and can be
 * retried; a job with no row runs invisibly and reports to nobody. `dispatchJob` is bounded and
 * never throws, so a broker outage marks the row `failed` with a reason rather than hanging the
 * screen (`billing/dispatch.ts` documents the whole shape).
 */

export interface TenantBackupRow {
  id: string;
  kind: 'backup' | 'standalone_export';
  status: 'pending' | 'ready' | 'failed' | 'restoring';
  key: string | null;
  sizeBytes: number | null;
  schemaVersion: string;
  /** True when this artifact can still be restored onto this deployment. */
  restorable: boolean;
  contents: BackupContents | null;
  note: string | null;
  error: string | null;
  createdAt: Date;
  completedAt: Date | null;
  ageDays: number;
}

function toRow(
  row: {
    id: string;
    kind: string;
    status: string;
    key: string | null;
    sizeBytes: number | null;
    schemaVersion: string;
    contents: unknown;
    note: string | null;
    error: string | null;
    createdAt: Date;
    completedAt: Date | null;
  },
  now: Date,
): TenantBackupRow {
  return {
    id: row.id,
    kind: row.kind as TenantBackupRow['kind'],
    status: row.status as TenantBackupRow['status'],
    key: row.key,
    sizeBytes: row.sizeBytes,
    schemaVersion: row.schemaVersion,
    restorable: row.schemaVersion === CURRENT_SCHEMA_VERSION,
    contents: (row.contents as BackupContents | null) ?? null,
    note: row.note,
    error: row.error,
    createdAt: row.createdAt,
    completedAt: row.completedAt,
    ageDays: Math.max(0, Math.floor((now.getTime() - row.createdAt.getTime()) / 86_400_000)),
  };
}

const ROW_SELECT = {
  id: true,
  kind: true,
  status: true,
  key: true,
  sizeBytes: true,
  schemaVersion: true,
  contents: true,
  note: true,
  error: true,
  createdAt: true,
  completedAt: true,
} as const;

export async function listTenantBackups(
  actor: Actor,
  tenantId: string,
  now: Date = new Date(),
): Promise<TenantBackupRow[]> {
  const rows = await superAdminDb(actor).tenantBackup.findMany({
    where: { tenantId },
    orderBy: { createdAt: 'desc' },
    take: 50,
    select: ROW_SELECT,
  });

  return rows.map((row) => toRow(row, now));
}

export interface CreateBackupInput {
  actor: Actor;
  tenantId: string;
  actorUserId: string;
  note?: string;
  kind?: 'backup' | 'standalone_export';
}

export async function createTenantBackup(input: CreateBackupInput): Promise<TenantBackupRow> {
  const db = superAdminDb(input.actor);
  const kind = input.kind ?? 'backup';

  const created = await db.tenantBackup.create({
    data: {
      tenantId: input.tenantId,
      kind,
      status: 'pending',
      schemaVersion: CURRENT_SCHEMA_VERSION,
      appCommit: process.env.GIT_COMMIT ?? null,
      note: input.note?.trim() || null,
      createdById: input.actorUserId,
    },
    select: ROW_SELECT,
  });

  const accepted = await dispatchJob(
    'backup',
    tenantJob(input.tenantId, kind === 'standalone_export' ? BACKUP_JOBS.standalone : BACKUP_JOBS.build, {
      backupId: created.id,
    }),
  );

  if (!accepted) {
    // Marked failed rather than left `pending` forever. A pending row that nothing is working on
    // is the exact shape of "the backup I thought I had".
    await db.tenantBackup.update({
      where: { id: created.id },
      data: { status: 'failed', error: 'queue_unavailable', completedAt: new Date() },
    });
    logger().error({ tenantId: input.tenantId, backupId: created.id }, 'tenant backup could not be queued');
  }

  return toRow({ ...created, status: accepted ? 'pending' : 'failed' }, new Date());
}

export async function requestStandaloneExport(input: Omit<CreateBackupInput, 'kind'>): Promise<TenantBackupRow> {
  const env = getEnv();
  if (!env.STANDALONE_SOURCE_ARCHIVE) {
    throw new BackupError('noSourceArchive', 'STANDALONE_SOURCE_ARCHIVE is not set.');
  }
  return createTenantBackup({ ...input, kind: 'standalone_export' });
}

export interface RestoreRequestInput {
  actor: Actor;
  tenantId: string;
  backupId: string;
  actorUserId: string;
}

/**
 * Ask for a restore. The validation an operator can be told about happens HERE, synchronously, so
 * the refusal appears on the screen they are looking at rather than in a job that fails silently
 * two seconds later.
 */
export async function restoreTenantBackup(input: RestoreRequestInput): Promise<void> {
  const db = superAdminDb(input.actor);

  const backup = await db.tenantBackup.findFirst({
    where: { id: input.backupId, tenantId: input.tenantId },
    select: { id: true, status: true, key: true, schemaVersion: true, kind: true },
  });

  if (!backup) throw new BackupError('notFound', 'No such backup for this account.');
  if (backup.status !== 'ready' || !backup.key) {
    throw new BackupError('notReady', 'That backup has no artifact to restore from.');
  }
  if (backup.schemaVersion !== CURRENT_SCHEMA_VERSION) {
    throw new BackupError(
      'schemaMismatch',
      `That backup was taken at schema ${backup.schemaVersion}; this deployment is at ${CURRENT_SCHEMA_VERSION}.`,
    );
  }

  // One restore at a time per tenant. The purge lock inside the job serialises the platform, and
  // this stops a second CLICK becoming a second queued job that will sit waiting for the first.
  const running = await db.tenantBackup.count({
    where: { tenantId: input.tenantId, status: 'restoring' },
  });
  if (running > 0) throw new BackupError('busy', 'A restore is already running for this account.');

  await db.tenantBackup.update({ where: { id: backup.id }, data: { status: 'restoring', error: null } });

  // A SYSTEM job carrying tenantId in the payload — see BACKUP_JOBS in jobs/contract.ts for why
  // this one cannot run inside the transaction `createWorker` opens for a TenantJob.
  const accepted = await dispatchJob(
    'backup',
    systemJob(BACKUP_JOBS.restore, {
      tenantId: input.tenantId,
      backupId: backup.id,
      actorUserId: input.actorUserId,
    }),
  );

  if (!accepted) {
    await db.tenantBackup.update({
      where: { id: backup.id },
      data: { status: 'ready', error: 'queue_unavailable' },
    });
    throw new BackupError('busy', 'The job queue is unreachable; nothing was changed.');
  }
}

export async function downloadTenantBackup(
  actor: Actor,
  tenantId: string,
  backupId: string,
): Promise<string> {
  const backup = await superAdminDb(actor).tenantBackup.findFirst({
    where: { id: backupId, tenantId },
    select: { key: true, status: true },
  });

  if (!backup?.key || backup.status !== 'ready') {
    throw new BackupError('notReady', 'That backup has no artifact to download.');
  }

  // Minted per request and clamped, exactly like `/export/{token}` — never a durable link. The
  // artifact is a whole shop in one file, including its customers' names and phone numbers.
  return mediaStorage().signedUrl(
    backup.key,
    Math.min(getEnv().EXPORT_SIGNED_URL_TTL_SECONDS, MAX_SIGNED_URL_TTL_SECONDS),
  );
}

/**
 * Remove one backup — the object first, then the row.
 *
 * That order is the safe one. Object gone and row still there is a visible, reportable
 * inconsistency an operator can retry; row gone and object still there is a copy of a shop's data
 * under a prefix nothing points at, which `_backups/` is excluded from the orphan sweep for
 * exactly the same reason `_exports/` is — so nothing would ever collect it.
 */
export async function deleteTenantBackup(
  actor: Actor,
  tenantId: string,
  backupId: string,
): Promise<void> {
  const db = superAdminDb(actor);
  const backup = await db.tenantBackup.findFirst({
    where: { id: backupId, tenantId },
    select: { id: true, key: true, status: true },
  });

  if (!backup) throw new BackupError('notFound', 'No such backup for this account.');
  if (backup.status === 'restoring') {
    throw new BackupError('busy', 'That backup is being restored right now.');
  }

  if (backup.key) {
    await mediaStorage()
      .delete(backup.key)
      .catch((error: unknown) => {
        logger().error(
          { tenantId, key: backup.key, error: (error as Error).message },
          'a tenant backup object could not be deleted — the row is kept so it can be retried',
        );
        throw new BackupError('notFound', 'The artifact could not be removed; nothing was deleted.');
      });
  }

  await db.tenantBackup.delete({ where: { id: backup.id } });
}

export { CURRENT_SCHEMA_VERSION, isRestorableSchema } from './schema-version';
export { BackupError, type BackupContents, type BackupManifestFile } from './types';
export { BACKUP_TABLES, EXCLUDED_TABLES, CLASSIFIED_TABLES, DUMP_TABLES, RESTORE_TABLES, STANDALONE_EXTRA_TABLES } from './tables';
export { buildTenantBackup, tenantBackupKey, MAX_BACKUP_MEDIA_BYTES } from './build';
export { restoreFromArchive, type RestoreResult } from './restore';
export { readArchive, type ArchiveReader } from './archive';
