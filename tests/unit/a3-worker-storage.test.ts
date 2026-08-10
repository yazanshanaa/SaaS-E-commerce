import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * A3 — the driver has to be installed in the WORKER, which never imports the media barrel.
 *
 * The chain that matters: `src/worker/index.ts` -> `@/server/queues` -> the lazy path
 * `./media/processors/process-upload`. Nothing in it touches `src/server/media/index.ts`, whose
 * import side effect is what registers the R2 driver. So a processor that resolved storage with a
 * bare `storage()` would, with STORAGE_DRIVER=r2, hit "no R2 adapter is registered" on its first
 * call — and in `process-upload` that throw landed inside the `catch` that converts ANY failure
 * into a PERMANENT `sourceMissing`: the job completes, the row is marked failed, the merchant is
 * told their original is missing, and no retry ever happens. On a fresh production deploy that is
 * every upload.
 *
 * These two cases fix the shape of the fix, not just its effect: the driver must be reachable
 * from the processor's own import graph, and the processors must not go back to the bare registry.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const PROCESSOR_FILES = [
  'src/server/media/processors/process-upload.ts',
  'src/server/media/processors/cleanup-orphans.ts',
];

describe('the worker can install the production driver on its own', () => {
  const previous = process.env.STORAGE_DRIVER;

  beforeAll(async () => {
    process.env.STORAGE_DRIVER = 'r2';
    const { resetEnvCache } = await import('@/env');
    resetEnvCache();
  });

  afterAll(async () => {
    if (previous === undefined) delete process.env.STORAGE_DRIVER;
    else process.env.STORAGE_DRIVER = previous;

    const { resetEnvCache } = await import('@/env');
    resetEnvCache();
    const { setStorageAdapter } = await import('@/server/storage');
    setStorageAdapter(undefined);
    const { resetMediaStorageRegistration } = await import('@/server/media/storage');
    resetMediaStorageRegistration();
  });

  it('refuses a bare storage() under STORAGE_DRIVER=r2, and mediaStorage() installs the driver', async () => {
    const { storage } = await import('@/server/storage');

    // What the processors used to call. This is the throw that became a permanent failure.
    expect(() => storage()).toThrow(/no R2 adapter is registered/);

    // What they call now — reachable from `src/server/media/processors/*` without the barrel.
    const { mediaStorage } = await import('@/server/media/storage');
    expect(mediaStorage().driver).toBe('r2');

    // And the registry now answers for everything else in the process too.
    expect(storage().driver).toBe('r2');
  });
});

describe('the processors do not reach past the installer', () => {
  it('resolves storage through mediaStorage(), never a bare storage() import', async () => {
    for (const file of PROCESSOR_FILES) {
      const source = await readFile(path.join(repoRoot, file), 'utf8');

      expect(source, file).toContain("from '../storage'");
      // `@/server/storage` may still be imported for its key helpers and its error type — never
      // for the registry accessor itself, which is the import that broke the worker.
      expect(source, file).not.toMatch(/import \{[^}]*\bstorage\b[^}]*\} from '@\/server\/storage'/);
    }
  });
});
