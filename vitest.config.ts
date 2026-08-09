import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const src = fileURLToPath(new URL('./src', import.meta.url));

/**
 * Two projects, deliberately separated:
 *
 *  - `unit` needs nothing but Node. It runs everywhere, always.
 *  - `integration` needs a REAL PostgreSQL, because the thing under test is row-level
 *    security. No in-memory Postgres emulator implements RLS, and an isolation test that
 *    cannot fail is worse than no isolation test. The global setup boots one: it uses
 *    DATABASE_URL_TEST if you have the dev compose running, and otherwise starts a private
 *    embedded cluster so `pnpm test` is green on a machine without Docker.
 */
export default defineConfig({
  resolve: {
    alias: { '@': src },
  },
  test: {
    globals: false,
    // One embedded cluster, one schema: integration files would otherwise race on the same
    // rows. Unit tests are fast enough that serialising them costs nothing.
    fileParallelism: false,
    projects: [
      {
        resolve: { alias: { '@': src } },
        test: {
          name: 'unit',
          environment: 'node',
          include: ['tests/unit/**/*.test.ts'],
          setupFiles: ['tests/setup/unit-env.ts'],
        },
      },
      {
        resolve: { alias: { '@': src } },
        test: {
          name: 'integration',
          environment: 'node',
          include: ['tests/integration/**/*.test.ts'],
          globalSetup: ['tests/setup/db-global-setup.ts'],
          setupFiles: ['tests/setup/db-env.ts'],
          testTimeout: 60_000,
          hookTimeout: 240_000,
        },
      },
    ],
  },
});
