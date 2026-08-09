import { defineConfig, devices } from '@playwright/test';
import { E2E, mailFile, pgUrl } from './tests/e2e/support/env';

/**
 * Hostname-based tenant resolution is the whole point of proxy.ts, so the browser has to see
 * REAL hostnames. `--host-resolver-rules` maps the wildcard onto the local server, which means
 * the tests exercise admin.*, app.* and {slug}.* exactly as production does — no /etc/hosts
 * editing on a developer machine, and no shortcut through a Host header a browser would refuse
 * to set anyway.
 *
 * The webServer command boots a private PostgreSQL, migrates, seeds, and starts an SMTP sink
 * before Next, so this suite runs on a machine with neither Docker nor Redis.
 */
export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],
  timeout: 60_000,
  use: {
    baseURL: `http://${E2E.domain}:${E2E.webPort}`,
    trace: 'on-first-retry',
    locale: 'ar',
    timezoneId: 'Asia/Jerusalem',
    ignoreHTTPSErrors: true,
  },

  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: {
          args: [`--host-resolver-rules=MAP *${E2E.domain} 127.0.0.1, MAP ${E2E.domain} 127.0.0.1`],
        },
      },
    },
  ],

  webServer: {
    // ONE process owns the whole stack: postgres, migrations, the seed, the SMTP sink and the
    // Next server. Playwright starts `webServer` BEFORE globalSetup, so a database created in
    // globalSetup would not exist yet when the server boots — owning the order here removes
    // that race instead of sleeping through it.
    command: `pnpm build && npx tsx tests/e2e/support/start-stack.ts`,
    // A hostname-agnostic health endpoint: every other path resolves a tenant, and 127.0.0.1
    // is not one — so a readiness probe against them would poll a 404 forever.
    url: `http://127.0.0.1:${E2E.webPort}/internal/health`,
    reuseExistingServer: false,
    timeout: 300_000,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      NODE_ENV: 'production',
      DOMAIN: E2E.domain,
      PUBLIC_SCHEME: 'http',
      ADMIN_HOST_PREFIX: 'admin',
      APP_HOST_PREFIX: 'app',
      LOG_LEVEL: 'warn',

      DATABASE_URL: pgUrl('app_web', 'app_web'),
      DATABASE_URL_SYSTEM: pgUrl('app_system', 'app_system'),
      DATABASE_URL_MIGRATE: pgUrl('app_migrate', 'app_migrate'),

      // Intentionally unreachable: every cache path must degrade to the database.
      REDIS_URL: 'redis://127.0.0.1:6399',

      BETTER_AUTH_SECRET: Buffer.alloc(32, 21).toString('base64'),
      BETTER_AUTH_URL: `http://app.${E2E.domain}:${E2E.webPort}`,
      ENCRYPTION_KEY: Buffer.alloc(32, 23).toString('base64'),
      WEBHOOK_HMAC_SECRET: Buffer.alloc(32, 25).toString('base64'),

      // Raised so the behavioural assertions below are not order-dependent. The limit itself
      // is declared in the auth config and asserted by tests/unit/guardrails.test.ts.
      RATE_LIMIT_LOGIN_PER_15MIN: '500',

      MAIL_DRIVER: 'smtp',
      MAIL_FROM: 'no-reply@souqbartaa.test',
      SMTP_HOST: '127.0.0.1',
      SMTP_PORT: String(E2E.smtpPort),
      SMTP_SECURE: 'false',

      // The dev media route refuses to run in production; nothing in this suite serves media.
      STORAGE_DRIVER: 'local',
      E2E_MAIL_FILE: mailFile,
    },
  },
});
