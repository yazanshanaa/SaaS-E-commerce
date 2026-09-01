'use server';

import { redirect } from 'next/navigation';
import {
  createTenantBackup,
  deleteTenantBackup,
  downloadTenantBackup,
  getAccount,
  requestStandaloneExport,
  restoreTenantBackup,
} from '@/server/admin';
import { auditPlatformAction, auditTenantAction } from '@/server/admin/audit';
import { BackupError } from '@/server/tenant-backup';
import { requireAdminPage } from '../../../_components/guard';

/**
 * The per-account backup actions (Q24, Q26).
 *
 * EVERY ONE WRITES BOTH AUDIT LOGS, and that pairing is the Phase 6 rule applied to the most
 * consequential buttons on the platform: `auditTenantAction` puts the row where an operator
 * investigating THIS shop will find it, and `auditPlatformAction` puts it where it survives the
 * purge that a restore-gone-wrong might be followed by. A tenant-only row would vanish in exactly
 * the incident somebody would be reconstructing.
 *
 * THE RESTORE IS TYPE-THE-SLUG, checked here rather than by the form. A confirmation the server
 * does not verify is decoration, and this is the one action in the admin panel that destroys data
 * on purpose.
 */

function back(tenantId: string, query: string): never {
  redirect(`/accounts/${tenantId}/backups?${query}`);
}

function failure(error: unknown): string {
  const reason = error instanceof BackupError ? error.reason : 'unknown';
  return `error=admin:accountBackups.errors.${reason}`;
}

export async function createBackupAction(form: FormData): Promise<void> {
  const ctx = await requireAdminPage();
  const tenantId = String(form.get('tenantId') ?? '');
  const note = String(form.get('note') ?? '');

  try {
    const row = await createTenantBackup({
      actor: ctx.actor,
      tenantId,
      actorUserId: ctx.userId,
      note,
    });

    await auditTenantAction(ctx, tenantId, {
      action: 'tenant_backup.created',
      entityType: 'tenant_backup',
      entityId: row.id,
      after: { kind: row.kind, schemaVersion: row.schemaVersion },
    });
    await auditPlatformAction(ctx, {
      action: 'tenant_backup.created',
      entityType: 'tenant_backup',
      entityId: row.id,
      tenantRef: tenantId,
    });
  } catch (error) {
    back(tenantId, failure(error));
  }

  back(tenantId, 'ok=admin:accountBackups.notices.queued');
}

export async function createStandaloneExportAction(form: FormData): Promise<void> {
  const ctx = await requireAdminPage();
  const tenantId = String(form.get('tenantId') ?? '');

  try {
    const row = await requestStandaloneExport({
      actor: ctx.actor,
      tenantId,
      actorUserId: ctx.userId,
      note: String(form.get('note') ?? ''),
    });

    await auditTenantAction(ctx, tenantId, {
      action: 'tenant_backup.standalone_requested',
      entityType: 'tenant_backup',
      entityId: row.id,
    });
    await auditPlatformAction(ctx, {
      action: 'tenant_backup.standalone_requested',
      entityType: 'tenant_backup',
      entityId: row.id,
      tenantRef: tenantId,
    });
  } catch (error) {
    back(tenantId, failure(error));
  }

  back(tenantId, 'ok=admin:accountBackups.notices.standaloneQueued');
}

export async function restoreBackupAction(form: FormData): Promise<void> {
  const ctx = await requireAdminPage();
  const tenantId = String(form.get('tenantId') ?? '');
  const backupId = String(form.get('backupId') ?? '');
  const confirmation = String(form.get('confirmSlug') ?? '').trim();

  const account = await getAccount(ctx, tenantId);
  if (!account) back(tenantId, 'error=admin:accountBackups.errors.notFound');

  // The confirmation is the SERVER's check. A disabled button is a hint; this is the boundary.
  if (confirmation !== account.slug) {
    back(tenantId, 'error=admin:accountBackups.errors.confirmMismatch');
  }

  try {
    // Written BEFORE the job is queued: if the restore then goes wrong, the record of who asked
    // for it and when already exists, which is the first question anybody asks afterwards.
    await auditTenantAction(ctx, tenantId, {
      action: 'tenant_backup.restore_requested',
      entityType: 'tenant_backup',
      entityId: backupId,
    });
    await auditPlatformAction(ctx, {
      action: 'tenant_backup.restore_requested',
      entityType: 'tenant_backup',
      entityId: backupId,
      tenantRef: tenantId,
      before: { slug: account.slug },
    });

    await restoreTenantBackup({
      actor: ctx.actor,
      tenantId,
      backupId,
      actorUserId: ctx.userId,
    });
  } catch (error) {
    back(tenantId, failure(error));
  }

  back(tenantId, 'ok=admin:accountBackups.notices.restoreQueued');
}

export async function downloadBackupArtifactAction(form: FormData): Promise<void> {
  const ctx = await requireAdminPage();
  const tenantId = String(form.get('tenantId') ?? '');
  const backupId = String(form.get('backupId') ?? '');

  let url: string;
  try {
    await auditTenantAction(ctx, tenantId, {
      action: 'tenant_backup.downloaded',
      entityType: 'tenant_backup',
      entityId: backupId,
    });
    await auditPlatformAction(ctx, {
      action: 'tenant_backup.downloaded',
      entityType: 'tenant_backup',
      entityId: backupId,
      tenantRef: tenantId,
    });

    url = await downloadTenantBackup(ctx.actor, tenantId, backupId);
  } catch (error) {
    back(tenantId, failure(error));
  }

  redirect(url);
}

export async function deleteBackupAction(form: FormData): Promise<void> {
  const ctx = await requireAdminPage();
  const tenantId = String(form.get('tenantId') ?? '');
  const backupId = String(form.get('backupId') ?? '');

  try {
    await deleteTenantBackup(ctx.actor, tenantId, backupId);

    await auditTenantAction(ctx, tenantId, {
      action: 'tenant_backup.deleted',
      entityType: 'tenant_backup',
      entityId: backupId,
    });
    await auditPlatformAction(ctx, {
      action: 'tenant_backup.deleted',
      entityType: 'tenant_backup',
      entityId: backupId,
      tenantRef: tenantId,
    });
  } catch (error) {
    back(tenantId, failure(error));
  }

  back(tenantId, 'ok=admin:accountBackups.notices.deleted');
}
