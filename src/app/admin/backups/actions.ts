'use server';

import { redirect } from 'next/navigation';
import { downloadBackupObject, requestBackupRun } from '@/server/admin';
import { requireAdminPage } from '../_components/guard';

/**
 * The two things the backups screen can DO. There is deliberately no third (Q23): a restore drops
 * and recreates a database, and a button for it on a page an operator opens to READ is one
 * mis-click away from the worst outcome the page exists to prevent. `docs/DEPLOY.md` §6 stays the
 * procedure, and the screen renders its steps.
 *
 * REDIRECT STYLE, like every other admin form: the page re-reads the sidecar's status and the
 * manifest list afterwards, so what the operator sees is the state of the world rather than the
 * state of a form.
 */

export async function requestBackupRunAction(): Promise<void> {
  const ctx = await requireAdminPage();
  const result = await requestBackupRun(ctx);

  redirect(
    result.ok
      ? '/backups?ok=admin:backups.notices.runRequested'
      : `/backups?error=admin:backups.errors.${result.reason}`,
  );
}

/**
 * Hands back a short-lived signed URL to ONE encrypted dump, audited before it is minted.
 *
 * The redirect goes to R2 rather than streaming through this server, and that is the one place
 * this differs from `/export/{token}`: a dump is measured in gigabytes and holds no tenant's
 * bearer token — it is a ciphertext whose decryption key is deliberately not on this machine
 * (docs/DEPLOY.md §2), reachable only by a super-admin session that was just written to the
 * platform audit log.
 */
export async function downloadBackupAction(form: FormData): Promise<void> {
  const ctx = await requireAdminPage();
  const key = String(form.get('key') ?? '');

  const result = await downloadBackupObject(ctx, key);
  if ('ok' in result) redirect(`/backups?error=admin:backups.errors.${result.reason}`);

  redirect(result.url);
}
