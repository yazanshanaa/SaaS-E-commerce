import { getEnv } from '@/env';
import { logger } from '@/server/logger';
import { LocalStorageAdapter } from './local-driver';
import type { StorageAdapter } from './types';

/**
 * The storage registry.
 *
 * A3 implements the production R2 driver in `src/server/media/storage` and registers it here
 * with `setStorageAdapter()` at module load. Until then — and always in development and tests
 * — the local-disk driver stands in.
 *
 * Why a registry and not a direct import: the lint rule forbids importing the S3 client
 * outside `src/server/media/storage`, and this module is imported by `src/server/export`,
 * which ships in Phase 1. A direct import would either break that rule or make Phase 1 depend
 * on a folder that does not exist yet.
 */

let adapter: StorageAdapter | undefined;

export function setStorageAdapter(next: StorageAdapter | undefined): void {
  adapter = next;
}

export function storage(): StorageAdapter {
  if (adapter) return adapter;

  const env = getEnv();
  if (env.STORAGE_DRIVER === 'r2') {
    throw new Error(
      'STORAGE_DRIVER=r2 but no R2 adapter is registered. A3 registers it from src/server/media/storage.',
    );
  }

  /**
   * The driver policy is enforced HERE rather than in env.ts, and the difference matters:
   * `next build` runs with NODE_ENV=production, so a check at env-parse time would refuse to
   * build a perfectly valid development checkout. Enforcing at the point of use still refuses
   * to SERVE a byte from local disk in production — which is the thing invariant 4 protects.
   */
  if (env.NODE_ENV === 'production' && !env.E2E_ALLOW_LOCAL_STORAGE) {
    throw new Error(
      'STORAGE_DRIVER=local is not allowed in production: media must be delivered by the CDN in front of R2, never from the app server disk.',
    );
  }

  /**
   * The harness opt-out, and it is loud on purpose.
   *
   * `pnpm e2e` runs the real production build so the suite tests the artefact that ships, which
   * puts it on the wrong side of the check above. One flag, set in one file
   * (`playwright.config.ts`), lets that stack write to a temp directory — and anything else that
   * ever sets it announces itself at boot rather than serving a merchant's images off local disk
   * in silence. A production deployment that trips this line is misconfigured, and the log is
   * where that gets noticed.
   */
  if (env.NODE_ENV === 'production') {
    logger().warn(
      'E2E_ALLOW_LOCAL_STORAGE is set: serving media from local disk in a production build. This is the test harness opt-out and must never be set on a real deployment.',
    );
  }

  adapter = new LocalStorageAdapter();
  return adapter;
}

export { LocalStorageAdapter } from './local-driver';
export {
  MAX_SIGNED_URL_TTL_SECONDS,
  StorageError,
  tenantPrefix,
  mediaPrefix,
  exportsPrefix,
  selfServeExportsPrefix,
  backupsPrefix,
  isExportKey,
  isBackupKey,
  isMediaKey,
  type StorageAdapter,
  type PutObjectOptions,
  type StoredObject,
} from './types';
