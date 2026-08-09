import { getEnv } from '@/env';
import { logger } from '@/server/logger';
import { setStorageAdapter, storage, type StorageAdapter } from '@/server/storage';
import { R2StorageAdapter } from './r2-driver';

/**
 * Driver registration.
 *
 * `src/server/storage` holds the interface and the development local-disk driver; A3 holds the
 * production R2 driver. The registry in between exists so `src/server/export` (Phase 1) could
 * depend on storage before this folder existed.
 *
 * Registration is IDEMPOTENT and LAZY: it only builds an adapter when STORAGE_DRIVER=r2, and the
 * adapter itself only opens an S3 client on its first call. Importing this module in a
 * development checkout with no credentials therefore costs nothing and changes nothing — the
 * local driver keeps serving, which is what makes `pnpm dev` and the whole test suite work
 * offline.
 */

let registered = false;

/**
 * Install the production driver when the environment asks for it, and do nothing otherwise.
 *
 * Deliberately does NOT call `storage()` on the way out: that would materialise the local driver
 * as a side effect of an import, and in a misconfigured production deployment
 * (STORAGE_DRIVER=local) it would turn a clear runtime refusal into a module that throws while
 * being imported — the hardest kind of failure to read from a stack trace.
 */
export function registerMediaStorage(): void {
  if (registered) return;

  const env = getEnv();
  if (env.STORAGE_DRIVER === 'r2') {
    setStorageAdapter(new R2StorageAdapter());
    logger().info({ driver: 'r2', bucket: env.R2_BUCKET }, 'storage driver registered');
  }

  registered = true;
}

/** The adapter currently in force. A thin pass-through, so callers need one import, not two. */
export function mediaStorage(): StorageAdapter {
  registerMediaStorage();
  return storage();
}

/** Test-only: forget that registration ran, so a test can install its own adapter. */
export function resetMediaStorageRegistration(): void {
  registered = false;
}

export { R2StorageAdapter, SIGV4_MAX_TTL_SECONDS, type R2StorageAdapterOptions } from './r2-driver';
