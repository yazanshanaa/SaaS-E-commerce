import { getEnv } from '@/env';
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
  if (env.NODE_ENV === 'production') {
    throw new Error(
      'STORAGE_DRIVER=local is not allowed in production: media must be delivered by the CDN in front of R2, never from the app server disk.',
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
  isExportKey,
  isMediaKey,
  type StorageAdapter,
  type PutObjectOptions,
  type StoredObject,
} from './types';
