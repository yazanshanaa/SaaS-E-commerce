/**
 * Unit tests must not need infrastructure. Everything env.ts requires is stubbed with values
 * that are obviously fake — a test that starts passing because of a real secret is a test
 * that stopped testing anything.
 */
// NODE_ENV is typed readonly by @types/node; the harness legitimately sets it.
(process.env as Record<string, string | undefined>).NODE_ENV ??= 'test';
process.env.DOMAIN ??= 'souqbartaa.test';
process.env.PUBLIC_SCHEME ??= 'http';
process.env.DATABASE_URL ??= 'postgresql://app_web:app_web@127.0.0.1:5432/unused?schema=public';
process.env.DATABASE_URL_SYSTEM ??=
  'postgresql://app_system:app_system@127.0.0.1:5432/unused?schema=public';
process.env.DATABASE_URL_MIGRATE ??=
  'postgresql://app_migrate:app_migrate@127.0.0.1:5432/unused?schema=public';
process.env.REDIS_URL ??= 'redis://127.0.0.1:6379';
process.env.ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString('base64');
process.env.BETTER_AUTH_SECRET ??= Buffer.alloc(32, 9).toString('base64');
process.env.WEBHOOK_HMAC_SECRET ??= Buffer.alloc(32, 11).toString('base64');
process.env.MAIL_DRIVER ??= 'smtp';
process.env.MAIL_FROM ??= 'no-reply@souqbartaa.test';
process.env.STORAGE_DRIVER ??= 'local';
