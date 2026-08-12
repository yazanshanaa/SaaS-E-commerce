import { absoluteUrl, getEnv, platformHost } from '@/env';
import { PUBLIC_ACTOR, tenantDb, type TenantTx } from '@/server/db';
import { can } from '@/server/entitlements';
import { adapterForValue, isGatewayProvider } from '@/server/payments';
import { CONSENT_MAX_AGE_SECONDS } from '@/app/site/_data/consent';
import { MEDIA_CACHE_MAX_DAYS } from '@/server/media/cache';
import type { LegalFacts, LegalProcessorKey } from './types';

/**
 * Everything the generated legal copy is allowed to claim, read from the code that makes it true.
 *
 * This module exists so `content.ts` can be a pure function of facts and nothing else. A privacy
 * policy is the one artefact on this platform where a confident sentence about behaviour that does
 * not exist is worse than saying nothing — it is the first thing a data-subject request tests, and
 * it is the merchant, not the platform, who is asked to stand behind it.
 *
 * Two rules held here:
 *   1. no fact is inferred from a plan name or a feature key's NAME — every one is resolved
 *      through the same call the runtime makes;
 *   2. a processor is listed only when this deployment is actually configured to use it. Sentry
 *      with no DSN sends nothing, so naming it would be a false disclosure pointing the unusual
 *      way: claiming data leaves when it does not.
 */

/** The DSR box's public path on `app.{DOMAIN}` — allow-listed in `proxy.ts`. */
export const DSR_PATH = '/privacy-request';

export function dsrUrl(): string {
  return absoluteUrl(platformHost('app'), DSR_PATH);
}

/**
 * The address a data subject can write to instead of using the form.
 *
 * `MAIL_REPLY_TO` when the operator set one, because that is the mailbox a human reads; otherwise
 * the sending address, which at least reaches the platform. Never a hardcoded address — the domain
 * is a placeholder everywhere (CLAUDE.md).
 */
export function contactEmail(): string {
  const env = getEnv();
  return env.MAIL_REPLY_TO?.trim() || env.MAIL_FROM;
}

function configuredProcessors(input: {
  analyticsEnabled: boolean;
  pushEnabled: boolean;
  collectsOrders: boolean;
  activeGatewayIsLocal: boolean;
}): LegalProcessorKey[] {
  const env = getEnv();
  const keys: LegalProcessorKey[] = [];

  /**
   * Storage and delivery. Present for every tenant on every plan: product images live in R2 and
   * are served through the CDN in front of it, and the platform's own hostnames sit behind the
   * Cloudflare proxy. There is no configuration under which a storefront does not touch it.
   */
  keys.push('cloudflare');

  // Mail leaves the platform either through Resend or through whatever SMTP relay is configured.
  keys.push(env.MAIL_DRIVER === 'resend' && env.RESEND_API_KEY ? 'resend' : 'smtp');

  // Umami is SELF-HOSTED (CLAUDE.md's stack) but it is still a place visitor data is written, and
  // a policy that enumerates what exists while omitting where it lives is incomplete.
  if (input.analyticsEnabled && env.UMAMI_SCRIPT_URL) keys.push('umami');

  // The browser vendor's push service. A genuine third party — the endpoint host is theirs.
  if (input.pushEnabled) keys.push('pushService');

  /**
   * SENTRY IS NOT LISTED, and the omission is the accurate answer rather than a gap.
   *
   * `@sentry/nextjs` is a dependency and `SENTRY_DSN` is a validated env var, but nothing
   * initialises the SDK: there is no `Sentry.init`, no `withSentryConfig`, no `sentry.*.config.ts`,
   * and `src/instrumentation.ts` registers only the storage adapter. Not one byte has ever been
   * sent. Naming a processor on the strength of a configured DSN would be a false disclosure in the
   * direction nobody audits for — claiming data leaves when it does not — in the one document this
   * phase promises is true.
   *
   * Phase 7 owns wiring it (docs/PHASES.md). `tests/unit/phase6-legal.test.ts` fails the moment the
   * SDK is initialised anywhere, so whoever does that is told, in the failing assertion, that the
   * privacy copy now owes a line. That is the only reliable way to keep a disclosure honest across
   * a phase boundary.
   */

  // n8n is self-hosted too; what makes it worth naming is where it forwards to.
  if (env.N8N_WEBHOOK_URL) {
    keys.push('n8n');
    keys.push('whatsapp');
  }

  // A remote gateway is a processor. The local one is not — nothing leaves the platform for it.
  if (input.collectsOrders && !input.activeGatewayIsLocal) keys.push('gateway');

  return keys;
}

export interface LoadFactsOptions {
  /** The caller's transaction, when it already holds one (account creation, demo build). */
  tx?: TenantTx;
}

export async function loadLegalFacts(
  tenantId: string,
  options: LoadFactsOptions = {},
): Promise<LegalFacts> {
  const env = getEnv();
  const db = options.tx ?? tenantDb(tenantId, PUBLIC_ACTOR);

  const site = await db.site.findUnique({
    where: { tenantId },
    select: { name: true, sellingEnabled: true },
  });
  if (!site) throw new Error(`No site for tenant ${tenantId} — cannot generate legal pages.`);

  const tenant = await db.tenant.findUnique({
    where: { id: tenantId },
    select: { isDemo: true },
  });

  const gatewayRow = await db.gatewayConfig.findFirst({
    where: { tenantId, enabled: true },
    select: { provider: true },
    orderBy: { createdAt: 'asc' },
  });

  /**
   * `can()` reads through the entitlement cache, which is invalidated on every admin toggle — so
   * these are the same answers the storefront gets on its next render, not a snapshot of the plan.
   */
  const [analytics, push, paymentGateway] = await Promise.all([
    can(tenantId, 'analytics'),
    can(tenantId, 'push_notifications'),
    can(tenantId, 'payment_gateway'),
  ]);

  /**
   * Push needs a key pair as well as the feature. Phase 4 made "unconfigured" a first-class state —
   * the subscribe control never appears without VAPID keys — so a policy describing push
   * subscriptions on a deployment that cannot create one would describe nothing.
   */
  const pushEnabled = push === true && Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY);

  const activeAdapter =
    gatewayRow && isGatewayProvider(gatewayRow.provider)
      ? adapterForValue(gatewayRow.provider)
      : null;
  const activeGateway = activeAdapter?.status === 'active' ? activeAdapter : null;

  /** The storefront's own four conjuncts, in the same order and with the same meaning. */
  const collectsOrders = paymentGateway === true && site.sellingEnabled && activeGateway !== null;

  /**
   * "Local" means the adapter has nothing to authenticate with, because it has nobody to
   * authenticate to — the cash / bank-transfer adapter records what the merchant tells it and
   * transmits nothing. Derived from `credentialFields` rather than from the provider key, so a
   * later local adapter is classified correctly without editing this line.
   */
  const activeGatewayIsLocal = activeGateway !== null && activeGateway.credentialFields.length === 0;

  return {
    tenantId,
    siteName: site.name,
    isDemo: tenant?.isDemo ?? false,
    sellingEnabled: site.sellingEnabled,
    collectsOrders,
    analyticsEnabled: analytics === true,
    pushEnabled,
    activeGatewayProvider: activeGateway?.provider ?? null,
    activeGatewayIsLocal,
    retentionDays: env.RETENTION_DAYS,
    demoRequestRetentionDays: env.DEMO_REQUEST_RETENTION_DAYS,
    backupIntervalHours: env.BACKUP_INTERVAL_HOURS,
    backupRetentionDays: env.BACKUP_RETENTION_DAYS,
    mediaCacheDays: MEDIA_CACHE_MAX_DAYS,
    tombstoneRetentionDays: env.TOMBSTONE_RETENTION_DAYS,
    webhookRetentionDays: env.WEBHOOK_DELIVERY_RETENTION_DAYS,
    consentCookieDays: Math.round(CONSENT_MAX_AGE_SECONDS / 86_400),
    dsrUrl: dsrUrl(),
    contactEmail: contactEmail(),
    processors: configuredProcessors({
      analyticsEnabled: analytics === true,
      pushEnabled,
      collectsOrders,
      activeGatewayIsLocal,
    }),
  };
}
