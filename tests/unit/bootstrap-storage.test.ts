import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * A3 sync point 3, pinned so it cannot be silently un-serviced.
 *
 * `src/server/media/storage` is the only module in the repository permitted to construct an R2
 * client — `eslint.config.mjs` and `tests/unit/a3-s3-containment.test.ts` both enforce that — so
 * the adapter has to be installed by each process's own bootstrap. Everything outside the media
 * folder calls the bare `storage()` from `@/server/storage`, which throws under
 * STORAGE_DRIVER=r2 until something registers an adapter.
 *
 * The victim is Q18: on a fresh web container, a suspended merchant opening
 * `app.{DOMAIN}/export/{token}` from their WhatsApp message got a 500 rather than their
 * catalogue, unless a photo had happened to be uploaded through that same process first.
 * Intermittent, on the day their site went dark, for the one person the promise was written for.
 *
 * These are source-level assertions on purpose. Importing `src/worker/index.ts` would start a
 * worker, and `src/instrumentation.ts` only does its work when Next calls `register()` — neither
 * is something a unit test can exercise, but "the call is present in the bootstrap" is exactly
 * the property that regressed and it is checkable.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const read = (relative: string): string =>
  readFileSync(path.join(repoRoot, relative), 'utf8');

describe('both containers install the storage driver at boot', () => {
  it('the worker registers it before any job can ask for one', () => {
    const source = read('src/worker/index.ts');

    expect(source).toMatch(/import\s*\{[^}]*registerMediaStorage[^}]*\}\s*from\s*'@\/server\/media\/storage'/);
    // Called at module scope, not merely imported.
    expect(source).toMatch(/^registerMediaStorage\(\);$/m);
  });

  it('the web server registers it from instrumentation, which Next runs once per start', () => {
    const source = read('src/instrumentation.ts');

    expect(source).toMatch(/export async function register\(\)/);
    expect(source).toContain('registerMediaStorage');
    // Node-only: the edge runtime evaluates this file too, and has neither the S3 client nor the
    // Node built-ins it reaches for.
    expect(source).toContain('NEXT_RUNTIME');
  });

  it('the worker also schedules the orphan sweep — A3 sync point 1', () => {
    const source = read('src/worker/index.ts');

    expect(source).toMatch(/import\s*\{[^}]*scheduleMediaCleanup[^}]*\}\s*from\s*'@\/server\/media\/schedule'/);
    expect(source).toContain('await scheduleMediaCleanup();');
  });
});
