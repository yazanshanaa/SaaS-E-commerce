import { readFileSync } from 'node:fs';
import { TEST_HANDOFF_FILE, type TestDatabaseUrls } from './postgres-harness';

/**
 * Runs in every integration worker before any application module is imported, so that
 * `src/env.ts` and the Prisma clients see the harness's connection strings.
 *
 * The handoff is a file rather than process.env inheritance on purpose: worker processes are
 * forked by Vitest and a mutation made in globalSetup is not reliably visible to them.
 */
const urls = JSON.parse(readFileSync(TEST_HANDOFF_FILE, 'utf8')) as TestDatabaseUrls;

process.env.DATABASE_URL = urls.webUrl;
process.env.DATABASE_URL_SYSTEM = urls.systemUrl;
process.env.DATABASE_URL_MIGRATE = urls.migrateUrl;
process.env.DATABASE_URL_ADMIN = urls.adminUrl;
process.env.SHADOW_DATABASE_URL = urls.migrateUrl;

// NODE_ENV is typed readonly by @types/node; the harness legitimately sets it.
(process.env as Record<string, string | undefined>).NODE_ENV ??= 'test';
process.env.DOMAIN ??= 'souqbartaa.test';
process.env.ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString('base64');
process.env.BETTER_AUTH_SECRET ??= Buffer.alloc(32, 9).toString('base64');
process.env.WEBHOOK_HMAC_SECRET ??= Buffer.alloc(32, 11).toString('base64');
process.env.REDIS_URL ??= 'redis://127.0.0.1:6379';
