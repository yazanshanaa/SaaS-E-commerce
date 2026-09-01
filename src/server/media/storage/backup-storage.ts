import { S3Client } from '@aws-sdk/client-s3';
import { getEnv } from '@/env';
import type { StorageAdapter } from '@/server/storage';
import { R2StorageAdapter } from './r2-driver';

/**
 * READ-ONLY access to the BACKUP bucket, for the owner's backups screen (Q23).
 *
 * It lives in this folder because this folder is the only one allowed to import the S3 client —
 * eslint enforces it and `tests/unit/guardrails.test.ts` re-checks it by reading the source. It is
 * a SEPARATE function from `mediaStorage()` rather than a bucket argument to it, and that is the
 * point of the file:
 *
 *   - DIFFERENT BUCKET. `R2_BACKUP_BUCKET` holds encrypted `pg_dump` rounds of the whole platform.
 *     One stray call with the media bucket's key layout would list nothing and, worse, a stray
 *     write would put a tenant's photograph in the archive of every tenant that ever existed.
 *   - DIFFERENT CREDENTIALS, deliberately weaker. The sidecar's pair (`R2_BACKUP_ACCESS_KEY_ID`)
 *     can write and delete every historical dump; the web container is the process reachable from
 *     the internet and holds only `R2_BACKUP_READ_*`, which should be scoped to Object Read. The
 *     screen can therefore show and stream a backup and cannot destroy one — including by bug.
 *   - NEVER REGISTERED as the global adapter. `setStorageAdapter` is untouched here: this returns
 *     an instance to its one caller, so no code path can reach the backup bucket by asking for
 *     "storage" in the ordinary way.
 *
 * `configured()` exists because the honest state of this repository is "no R2 zone yet". The screen
 * asks first and renders an explanatory panel, instead of a stack trace, when the answer is no.
 */

let cached: StorageAdapter | undefined;

export function backupStorageConfigured(): boolean {
  const env = getEnv();
  return Boolean(
    env.R2_BACKUP_BUCKET &&
      env.R2_BACKUP_READ_ACCESS_KEY_ID &&
      env.R2_BACKUP_READ_SECRET_ACCESS_KEY &&
      (env.R2_BACKUP_ENDPOINT ?? env.R2_ENDPOINT ?? env.R2_ACCOUNT_ID),
  );
}

export class BackupStorageNotConfiguredError extends Error {
  constructor() {
    super(
      'The backup bucket is not configured for reading: set R2_BACKUP_BUCKET, R2_BACKUP_READ_ACCESS_KEY_ID and R2_BACKUP_READ_SECRET_ACCESS_KEY.',
    );
    this.name = 'BackupStorageNotConfiguredError';
  }
}

/**
 * The adapter, built on first use and memoised.
 *
 * `R2StorageAdapter` is reused rather than reimplemented — it already clamps `signedUrl` to the
 * one-hour ceiling, already refuses `publicUrl` for anything outside `media/` (so a dump can never
 * be handed a CDN URL), and already knows R2's path-style quirk. What differs is only the client
 * and the bucket, which is exactly what its constructor takes.
 */
export function backupStorage(): StorageAdapter {
  if (cached) return cached;
  if (!backupStorageConfigured()) throw new BackupStorageNotConfiguredError();

  const env = getEnv();
  const endpoint =
    env.R2_BACKUP_ENDPOINT ??
    env.R2_ENDPOINT ??
    (env.R2_ACCOUNT_ID ? `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com` : undefined);

  const client = new S3Client({
    region: env.R2_REGION,
    endpoint,
    forcePathStyle: true,
    credentials: {
      accessKeyId: env.R2_BACKUP_READ_ACCESS_KEY_ID!,
      secretAccessKey: env.R2_BACKUP_READ_SECRET_ACCESS_KEY!,
    },
  });

  cached = new R2StorageAdapter({ client, bucket: env.R2_BACKUP_BUCKET! });
  return cached;
}

/** Test-only, and the reason `cached` is not a module-level `const`. */
export function resetBackupStorage(): void {
  cached = undefined;
}
