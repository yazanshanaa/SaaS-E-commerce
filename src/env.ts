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
  /**
   * The ONE hole in invariant 4's production check, and it is deliberately greppable.
   *
   * The e2e stack runs the real production build (`NODE_ENV=production`) against a private
   * postgres and a temp directory, because testing anything else would not be testing the
   * artefact that ships. That combination hits `storage()`'s refusal of `local` in production —
   * which was harmless until B3, whose central act writes fifteen images, and which silently cost
   * that track three e2e cases (docs/decisions/b3.md §6).
   *
   * Set in exactly one place: `playwright.config.ts`. It is NOT in `.env.example` as a value
   * anyone should copy, and a real deployment that set it would still be serving media off the
   * app server's disk — so the guard reads it as an opt-out for a harness, never as a driver
   * choice, and says so when it lets one through.
   */
  E2E_ALLOW_LOCAL_STORAGE: z
    .enum(['0', '1'])
    .optional()
    .transform((value) => value === '1'),
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
  /**
   * How long a push may sit on the vendor's server waiting for a device to come back online.
   * A shop offer is perishable — a notification that arrives four days late is worse than one
   * that never arrives, because the merchant is judged for it.
   */
  PUSH_TTL_SECONDS: z.coerce.number().int().positive().max(2_419_200).default(86_400),
  /** How many endpoints one delivery job pushes to concurrently. */
  PUSH_SEND_CONCURRENCY: z.coerce.number().int().positive().max(100).default(20),

  // --- Domains (Phase 4) ----------------------------------------------------
  /**
   * Verification asks PUBLIC resolvers, never the container's.
   *
   * A merchant adds the CNAME and clicks verify a minute later. A caching resolver that has
   * already answered NXDOMAIN for that name will keep answering it for the whole negative TTL —
   * so the merchant, who did everything right, is told their DNS is wrong. Asking 1.1.1.1 and
   * 8.8.8.8 directly is the closest we get to what the ACME server will see.
   */
  DNS_RESOLVERS: z.string().default('1.1.1.1,8.8.8.8'),
  DNS_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),

  // --- Internal service-to-service (worker -> web) --------------------------
  // The worker is a separate container and `revalidateTag()` only works inside the Next
  // server, so the queue reaches the data cache through `/internal/revalidate`. Internal to
  // the docker network; the secret is the second layer and is REQUIRED in production.
  INTERNAL_BASE_URL: z.string().default('http://127.0.0.1:3000'),
  INTERNAL_API_SECRET: z.string().optional(),
  INTERNAL_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),

  // --- Lifecycle ------------------------------------------------------------
  RETENTION_DAYS: z.coerce.number().int().positive().default(30),
  DEMO_REQUEST_RETENTION_DAYS: z.coerce.number().int().positive().default(30),
  LIFECYCLE_SWEEP_CRON: z.string().default('0 3 * * *'),

  // --- Rate limits ----------------------------------------------------------
  RATE_LIMIT_PUBLIC_FORM_PER_HOUR: z.coerce.number().int().positive().default(5),
  RATE_LIMIT_LOGIN_PER_15MIN: z.coerce.number().int().positive().default(10),
  RATE_LIMIT_UPLOAD_PER_MINUTE: z.coerce.number().int().positive().default(30),
  RATE_LIMIT_EXPORT_DOWNLOAD_PER_HOUR: z.coerce.number().int().positive().default(20),
  /** Each verify attempt is up to four live DNS queries against public resolvers. */
  RATE_LIMIT_DOMAIN_VERIFY_PER_HOUR: z.coerce.number().int().positive().default(20),
  /** A visitor subscribing to push. Generous for a person, useless for a loop. */
  RATE_LIMIT_PUSH_SUBSCRIBE_PER_HOUR: z.coerce.number().int().positive().default(20),
  /**
   * Per TENANT, per rolling day. This is not an abuse control so much as a reputation one:
   * a shop that pushes six times a day is a shop everyone mutes, and the permission is
   * revoked at the OS level where no merchant can win it back.
   */
  RATE_LIMIT_PUSH_SEND_PER_DAY: z.coerce.number().int().positive().default(5),
  /**
   * Phase 5. A visitor placing an order, per tenant per IP per hour.
   *
   * This is the OUTER bound only, and it degrades open like every other Redis-backed throttle
   * here. The bound that must not degrade is the per-tenant hourly ceiling in
   * `src/server/orders`, counted off `Order` rows inside the checkout transaction — an order is
   * a row a stranger creates on a merchant's account, and a cache blink must not lift that.
   */
  RATE_LIMIT_CHECKOUT_PER_HOUR: z.coerce.number().int().positive().default(10),
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

/**
 * The port the platform actually answers on, or none.
 *
 * In production there is no port and this is the empty string. In development and in the e2e
 * stack the platform listens on one, and a URL built without it points at a server that is not
 * there. `BETTER_AUTH_URL` is the only place that port is written down, which is why it is the
 * source here — the same derivation `platformOrigins()` already makes for trusted origins, and
 * for the same reason.
 */
export function publicPortSuffix(): string {
  const configured = getEnv().BETTER_AUTH_URL;
  if (!configured) return '';

  try {
    const port = new URL(configured).port;
    return port ? `:${port}` : '';
  } catch {
    return '';
  }
}

/**
 * A URL a HUMAN will open, on one of this platform's own hosts.
 *
 * IT CARRIES THE PORT, and that is not a detail. better-auth validates `callbackURL` against
 * `trustedOrigins`, which `platformOrigins()` builds WITH the port — so a reset link built
 * without one produced two origins that could never match and answered
 * `{"code":"INVALID_CALLBACK_URL"}`. Every owner invitation A1 sends and every staff invitation
 * B2 sends goes through this function, so in development and in the e2e stack the whole
 * invitation path was dead: the mail arrived, the link resolved, and better-auth refused it.
 *
 * Production was unaffected — there is no port there, so the two agreed by accident. That is
 * precisely what made it survive: the one environment where it worked is the one nobody was
 * building in. It is also the second time this exact mismatch has cost this platform a login;
 * `platformOrigins()` carries the note from the first.
 *
 * Q18's export link goes through here too, so a suspended merchant's download works in dev now
 * as well.
 */
export function absoluteUrl(host: string, pathname = '/'): string {
  const path = pathname.startsWith('/') ? pathname : `/${pathname}`;
  return `${getEnv().PUBLIC_SCHEME}://${host}${publicPortSuffix()}${path}`;
}

/** `app.{DOMAIN}/export/{token}` — the stable, revocable Q18 link. Never a storage URL. */
export function exportDownloadUrl(token: string): string {
  return absoluteUrl(platformHost('app'), `/export/${token}`);
}
