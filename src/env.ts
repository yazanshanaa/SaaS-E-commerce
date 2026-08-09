import { z } from 'zod';

/**
 * The single validated view of the environment.
 *
 * Two rules this file exists to keep:
 *   - invariant 7: no secrets in code, and a new variable lands with its .env.example line;
 *   - the domain is a PLACEHOLDER. Nothing anywhere may hardcode souqbartaa.com — every
 *     hostname is derived from DOMAIN, which is why it is required rather than defaulted to
 *     something that would silently "work" in production.
 */

const nonEmpty = z.string().min(1);

/** 32 bytes, base64. Anything shorter is a weaker key than the algorithm assumes. */
const base64Key32 = z
  .string()
  .min(1)
  .refine((v) => Buffer.from(v, 'base64').length >= 32, {
    message: 'must be at least 32 bytes of base64 (openssl rand -base64 32)',
  });

const booleanish = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === 'boolean' ? v : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())));

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  TZ: z.string().default('Asia/Jerusalem'),

  // --- Platform identity ----------------------------------------------------
  DOMAIN: nonEmpty,
  PUBLIC_SCHEME: z.enum(['http', 'https']).default('https'),
  ADMIN_HOST_PREFIX: z.string().default('admin'),
  APP_HOST_PREFIX: z.string().default('app'),

  // --- Database -------------------------------------------------------------
  DATABASE_URL: nonEmpty,
  DATABASE_URL_SYSTEM: z.string().optional(),
  DATABASE_URL_MIGRATE: z.string().optional(),

  // --- Redis ----------------------------------------------------------------
  REDIS_URL: nonEmpty,
  REDIS_CACHE_DB: z.coerce.number().int().min(0).default(0),
  REDIS_QUEUE_DB: z.coerce.number().int().min(0).default(0),

  // --- Auth -----------------------------------------------------------------
  BETTER_AUTH_SECRET: base64Key32,
  BETTER_AUTH_URL: z.string().optional(),
  SESSION_EXPIRES_IN: z.coerce.number().int().positive().default(60 * 60 * 24 * 7),
  SESSION_UPDATE_AGE: z.coerce.number().int().positive().default(60 * 60 * 24),

  // --- Encryption -----------------------------------------------------------
  ENCRYPTION_KEY: base64Key32,

  // --- Storage --------------------------------------------------------------
  STORAGE_DRIVER: z.enum(['local', 'r2']).default('local'),
  LOCAL_STORAGE_DIR: z.string().default('./storage'),
  R2_ACCOUNT_ID: z.string().optional(),
  R2_ACCESS_KEY_ID: z.string().optional(),
  R2_SECRET_ACCESS_KEY: z.string().optional(),
  R2_BUCKET: z.string().default('souq-bartaa'),
  R2_REGION: z.string().default('auto'),
  R2_ENDPOINT: z.string().optional(),
  R2_SSE_ALGORITHM: z.string().default('AES256'),
  CDN_PUBLIC_BASE_URL: z.string().optional(),
  EXPORT_SIGNED_URL_TTL_SECONDS: z.coerce.number().int().positive().max(3600).default(3600),

  // --- Mail -----------------------------------------------------------------
  MAIL_DRIVER: z.enum(['resend', 'smtp']).default('smtp'),
  MAIL_FROM: nonEmpty,
  MAIL_FROM_NAME: z.string().default('سوق برطعة'),
  MAIL_REPLY_TO: z.string().optional(),
  RESEND_API_KEY: z.string().optional(),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().positive().default(1025),
  SMTP_SECURE: booleanish.default(false),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),

  // --- Analytics ------------------------------------------------------------
  UMAMI_BASE_URL: z.string().optional(),
  UMAMI_SCRIPT_URL: z.string().optional(),
  UMAMI_API_USERNAME: z.string().optional(),
  UMAMI_API_PASSWORD: z.string().optional(),
  UMAMI_API_TOKEN: z.string().optional(),

  // --- Webhooks / n8n -------------------------------------------------------
  N8N_BASE_URL: z.string().optional(),
  N8N_WEBHOOK_URL: z.string().optional(),
  WEBHOOK_HMAC_SECRET: base64Key32,
  WEBHOOK_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  WEBHOOK_MAX_ATTEMPTS: z.coerce.number().int().positive().default(6),

  // --- Sentry ---------------------------------------------------------------
  SENTRY_DSN: z.string().optional(),
  SENTRY_ENVIRONMENT: z.string().default('development'),
  SENTRY_TRACES_SAMPLE_RATE: z.coerce.number().min(0).max(1).default(0.1),

  // --- Cloudflare -----------------------------------------------------------
  CLOUDFLARE_API_TOKEN: z.string().optional(),
  CLOUDFLARE_ZONE_ID: z.string().optional(),
  TRUST_CLOUDFLARE: booleanish.default(true),

  // --- Web Push (Phase 4) ---------------------------------------------------
  VAPID_PUBLIC_KEY: z.string().optional(),
  VAPID_PRIVATE_KEY: z.string().optional(),
  VAPID_SUBJECT: z.string().optional(),

  // --- Lifecycle ------------------------------------------------------------
  RETENTION_DAYS: z.coerce.number().int().positive().default(30),
  DEMO_REQUEST_RETENTION_DAYS: z.coerce.number().int().positive().default(30),
  LIFECYCLE_SWEEP_CRON: z.string().default('0 3 * * *'),

  // --- Rate limits ----------------------------------------------------------
  RATE_LIMIT_PUBLIC_FORM_PER_HOUR: z.coerce.number().int().positive().default(5),
  RATE_LIMIT_LOGIN_PER_15MIN: z.coerce.number().int().positive().default(10),
  RATE_LIMIT_UPLOAD_PER_MINUTE: z.coerce.number().int().positive().default(30),
  RATE_LIMIT_EXPORT_DOWNLOAD_PER_HOUR: z.coerce.number().int().positive().default(20),
});

export type Env = z.infer<typeof schema>;

function load(): Env {
  const parsed = schema.safeParse(process.env);

  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment.\n${details}\n\nSee .env.example for the full surface.`);
  }

  return parsed.data;
}

let cached: Env | undefined;

/** Lazily validated so importing a module never explodes before the test harness sets env. */
export function getEnv(): Env {
  cached ??= load();
  return cached;
}

/** Test-only: forget the memoised value after mutating process.env. */
export function resetEnvCache(): void {
  cached = undefined;
}

// --- Derived helpers ---------------------------------------------------------

export function platformHost(prefix: 'admin' | 'app'): string {
  const env = getEnv();
  return `${prefix === 'admin' ? env.ADMIN_HOST_PREFIX : env.APP_HOST_PREFIX}.${env.DOMAIN}`;
}

export function storefrontHost(slug: string): string {
  return `${slug}.${getEnv().DOMAIN}`;
}

export function absoluteUrl(host: string, pathname = '/'): string {
  return `${getEnv().PUBLIC_SCHEME}://${host}${pathname.startsWith('/') ? pathname : `/${pathname}`}`;
}

/** `app.{DOMAIN}/export/{token}` — the stable, revocable Q18 link. Never a storage URL. */
export function exportDownloadUrl(token: string): string {
  return absoluteUrl(platformHost('app'), `/export/${token}`);
}
