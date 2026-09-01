import { z } from 'zod';
import * as billing from '@/server/billing';
import { InvalidTransitionError } from '@/server/billing';
import { authDb } from '@/server/db';
import { resolveFeatures } from '@/server/entitlements';
import { isReservedSlug } from '@/server/tenancy';
import { jerusalemMonthWindow } from '@/server/time';
import { logger } from '@/server/logger';
import { storefrontHost, absoluteUrl, getEnv, platformHost } from '@/env';
import { hmac } from '@/server/crypto';
import { consumeSlot } from '@/server/rate-limit';
import { TEMPLATE_KEYS, isTemplateKey } from '@/shared/site-contract';
import type { FeatureKey } from '@/shared/features';
import { auditPlatformAction, auditTenantAction } from './audit';
import type { AdminContext } from './context';
import { provisionAnalyticsWebsite, websiteVisits, isAnalyticsConfigured } from './analytics';
import {
  dateField,
  emailField,
  failure,
  invalid,
  optionalText,
  optionalWhatsappField,
  personNameField,
  slugField,
  type ActionState,
} from './validation';

/**
 * Account management — and account CREATION, which happens here and nowhere else (Q1).
 *
 * Every lifecycle transition below is a thin wrapper over `src/server/billing`. That is
 * invariant 5 and it is why these functions are so short: the panel decides WHO may press the
 * button and WHAT gets written to the audit trail; the billing service decides what the
 * transition means. A route that reached for `subscription.update` directly would pass its own
 * tests and quietly break the sweep, the reminders and the export promise all at once — which
 * is exactly what the guardrail scan in tests/unit/guardrails.test.ts refuses to allow.
 */

// -----------------------------------------------------------------------------
// Listing
// -----------------------------------------------------------------------------

export interface AccountFilters {
  q?: string;
  status?: 'active' | 'suspended';
  planKey?: string;
  kind?: 'real' | 'demo';
  page?: number;
  perPage?: number;
}

export interface AccountListRow {
  tenantId: string;
  name: string;
  slug: string;
  isDemo: boolean;
  state: string;
  planKey: string;
  planName: string;
  status: string;
  billingPeriod: string;
  currentPeriodEnd: Date | null;
  createdAt: Date;
}

export interface AccountList {
  rows: AccountListRow[];
  total: number;
  page: number;
  perPage: number;
}

const PER_PAGE = 25;

export async function listAccounts(
  ctx: AdminContext,
  filters: AccountFilters = {},
): Promise<AccountList> {
  const page = Math.max(1, filters.page ?? 1);
  const perPage = Math.min(100, Math.max(5, filters.perPage ?? PER_PAGE));

  const q = filters.q?.trim();
  const where = {
    ...(filters.kind ? { isDemo: filters.kind === 'demo' } : {}),
    ...(q
      ? {
          OR: [
            { name: { contains: q, mode: 'insensitive' as const } },
            { slug: { contains: q.toLowerCase() } },
          ],
        }
      : {}),
    ...(filters.status || filters.planKey
      ? {
          subscription: {
            is: {
              ...(filters.status ? { status: filters.status } : {}),
              ...(filters.planKey ? { plan: { is: { key: filters.planKey } } } : {}),
            },
          },
        }
      : {}),
  };

  const [tenants, total] = await Promise.all([
    ctx.db.tenant.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * perPage,
      take: perPage,
      select: {
        id: true,
        name: true,
        slug: true,
        isDemo: true,
        state: true,
        createdAt: true,
        subscription: {
          select: {
            status: true,
            billingPeriod: true,
            currentPeriodEnd: true,
            plan: { select: { key: true, name: true } },
          },
        },
      },
    }),
    ctx.db.tenant.count({ where }),
  ]);

  return {
    rows: tenants.map((tenant) => ({
      tenantId: tenant.id,
      name: tenant.name,
      slug: tenant.slug,
      isDemo: tenant.isDemo,
      state: tenant.state,
      planKey: tenant.subscription?.plan.key ?? '',
      planName: tenant.subscription?.plan.name ?? '',
      status: tenant.subscription?.status ?? 'active',
      billingPeriod: tenant.subscription?.billingPeriod ?? 'monthly',
      currentPeriodEnd: tenant.subscription?.currentPeriodEnd ?? null,
      createdAt: tenant.createdAt,
    })),
    total,
    page,
    perPage,
  };
}

// -----------------------------------------------------------------------------
// Detail
// -----------------------------------------------------------------------------

export interface AccountUsage {
  products: number;
  productsLimit: number | undefined;
  storageBytes: number;
  storageLimitMb: number | undefined;
  media: number;
  /** Phase 5. Total orders ever, and the ones placed in the current Asia/Jerusalem month. */
  orders: number;
  ordersThisMonth: number;
  /** `null` when analytics is off, unconfigured, unprovisioned, or simply unreachable. */
  visits: { visitors: number; pageviews: number; days: number } | null;
  visitsUnavailableReason:
    | 'feature_off'
    | 'not_configured'
    | 'no_website'
    | 'unreachable'
    | null;
}

export interface AccountDetail {
  tenantId: string;
  name: string;
  slug: string;
  storefrontUrl: string;
  isDemo: boolean;
  state: string;
  createdAt: Date;
  subscription: {
    id: string;
    status: string;
    billingPeriod: string;
    startedAt: Date;
    currentPeriodEnd: Date | null;
    suspendedAt: Date | null;
    retentionUntil: Date | null;
    retentionExtensions: number;
    planKey: string;
    planName: string;
    planHidden: boolean;
  } | null;
  site: {
    id: string;
    templateKey: string;
    umamiWebsiteId: string | null;
  } | null;
  owner: { userId: string; name: string; email: string; loginDisabled: boolean } | null;
  /**
   * The site's addresses, read-only. The default `{slug}.{DOMAIN}` always exists; custom domains
   * are whatever the merchant (or the owner, impersonating) attached via Phase 4's flow. The
   * OWNER's control over the whole feature is the `custom_domain` toggle on the permissions tab —
   * `customDomainOn` is that resolved value, so this panel can say where the switch lives instead
   * of duplicating Phase 4's verification machinery in a parallel admin path.
   */
  domains: Array<{
    id: string;
    hostname: string;
    status: string;
    verifiedAt: Date | null;
    failureReason: string | null;
  }>;
  customDomainOn: boolean;
  usage: AccountUsage;
  prioritySupport: boolean;
  /** Phase 5. Axis (a) for checkout — read from the resolved features, never from a plan name. */
  paymentGateway: boolean;
  /** Whether the merchant's own selling switch is on. Both are needed before checkout renders. */
  sellingEnabled: boolean;
}

export async function getAccount(
  ctx: AdminContext,
  tenantId: string,
): Promise<AccountDetail | null> {
  const tenant = await ctx.db.tenant.findUnique({
    where: { id: tenantId },
    select: {
      id: true,
      name: true,
      slug: true,
      isDemo: true,
      state: true,
      createdAt: true,
      storageBytesUsed: true,
      subscription: {
        select: {
          id: true,
          status: true,
          billingPeriod: true,
          startedAt: true,
          currentPeriodEnd: true,
          suspendedAt: true,
          retentionUntil: true,
          retentionExtensions: true,
          plan: { select: { key: true, name: true, hidden: true } },
        },
      },
      site: {
        select: { id: true, templateKey: true, umamiWebsiteId: true, sellingEnabled: true },
      },
    },
  });

  if (!tenant) return null;

  const month = jerusalemMonthWindow();

  const [features, products, media, ownerMember, orders, ordersThisMonth, domains] = await Promise.all([
    resolveFeatures(tenantId),
    ctx.db.product.count({ where: { tenantId } }),
    ctx.db.media.count({ where: { tenantId } }),
    ctx.db.member.findFirst({
      where: { tenantId, role: 'owner' },
      select: {
        userId: true,
        user: { select: { name: true, email: true, loginDisabled: true } },
      },
    }),
    ctx.db.order.count({ where: { tenantId } }),
    ctx.db.order.count({
      where: { tenantId, placedAt: { gte: month.start, lt: month.end } },
    }),
    ctx.db.domain.findMany({
      where: { tenantId, kind: 'custom' },
      orderBy: { createdAt: 'asc' },
      select: { id: true, hostname: true, status: true, verifiedAt: true, failureReason: true },
    }),
  ]);

  const analyticsOn = features.analytics === true;
  const websiteId = tenant.site?.umamiWebsiteId ?? null;

  let visits: AccountUsage['visits'] = null;
  let visitsUnavailableReason: AccountUsage['visitsUnavailableReason'] = null;

  if (!analyticsOn) {
    visitsUnavailableReason = 'feature_off';
  } else if (!isAnalyticsConfigured()) {
    visitsUnavailableReason = 'not_configured';
  } else if (!websiteId) {
    visitsUnavailableReason = 'no_website';
  } else {
    visits = await websiteVisits(websiteId);
    if (!visits) visitsUnavailableReason = 'unreachable';
  }

  return {
    tenantId: tenant.id,
    name: tenant.name,
    slug: tenant.slug,
    storefrontUrl: absoluteUrl(storefrontHost(tenant.slug)),
    isDemo: tenant.isDemo,
    state: tenant.state,
    createdAt: tenant.createdAt,
    subscription: tenant.subscription
      ? {
          id: tenant.subscription.id,
          status: tenant.subscription.status,
          billingPeriod: tenant.subscription.billingPeriod,
          startedAt: tenant.subscription.startedAt,
          currentPeriodEnd: tenant.subscription.currentPeriodEnd,
          suspendedAt: tenant.subscription.suspendedAt,
          retentionUntil: tenant.subscription.retentionUntil,
          retentionExtensions: tenant.subscription.retentionExtensions,
          planKey: tenant.subscription.plan.key,
          planName: tenant.subscription.plan.name,
          planHidden: tenant.subscription.plan.hidden,
        }
      : null,
    site: tenant.site
      ? {
          id: tenant.site.id,
          templateKey: tenant.site.templateKey,
          umamiWebsiteId: tenant.site.umamiWebsiteId,
        }
      : null,
    owner: ownerMember
      ? {
          userId: ownerMember.userId,
          name: ownerMember.user.name,
          email: ownerMember.user.email,
          loginDisabled: ownerMember.user.loginDisabled,
        }
      : null,
    domains,
    customDomainOn: features.custom_domain === true,
    usage: {
      products,
      productsLimit: features.products_limit as number | undefined,
      // BigInt never leaves this module: it does not survive serialisation into a client
      // component, and the number is bytes — nowhere near the safe-integer ceiling.
      storageBytes: Number(tenant.storageBytesUsed),
      storageLimitMb: features.storage_mb as number | undefined,
      media,
      orders,
      ordersThisMonth,
      visits,
      visitsUnavailableReason,
    },
    prioritySupport: features.priority_support === true,
    paymentGateway: features.payment_gateway === true,
    sellingEnabled: tenant.site?.sellingEnabled === true,
  };
}

// -----------------------------------------------------------------------------
// Creation — the only path that exists (Q1)
// -----------------------------------------------------------------------------

export const createAccountSchema = z.object({
  name: z.string().trim().min(2, 'admin:errors.nameTooShort').max(80, 'admin:errors.textTooLong'),
  slug: slugField,
  address: optionalText(200),
  phone: optionalText(40),
  whatsapp: optionalWhatsappField,
  ownerName: personNameField,
  ownerEmail: emailField,
  planKey: z.string().trim().min(1, 'admin:errors.required'),
  billingPeriod: z.enum(['monthly', 'yearly']),
  currentPeriodEnd: dateField,
  templateKey: z.string().trim().min(1, 'admin:errors.required'),
  sendPasswordLink: z.boolean(),
});

export type CreateAccountInput = z.infer<typeof createAccountSchema>;

export interface CreateAccountOutcome {
  tenantId: string;
  setupFeeRecorded: boolean;
  analyticsProvisioned: boolean;
  passwordLinkSent: boolean;
}

export async function createAccountFromAdmin(
  ctx: AdminContext,
  raw: unknown,
): Promise<{ state: ActionState } | { outcome: CreateAccountOutcome }> {
  const parsed = createAccountSchema.safeParse(raw);
  if (!parsed.success) return { state: invalid(parsed.error) };

  const input = parsed.data;

  if (isReservedSlug(input.slug)) {
    return { state: failure('admin:errors.validation', [
      { field: 'slug', messageKey: 'admin:errors.slugReserved' },
    ]) };
  }

  const taken = await ctx.db.tenant.findUnique({ where: { slug: input.slug }, select: { id: true } });
  if (taken) {
    return { state: failure('admin:errors.validation', [
      { field: 'slug', messageKey: 'admin:errors.slugTaken' },
    ]) };
  }

  const plan = await ctx.db.plan.findUnique({
    where: { key: input.planKey },
    select: { id: true, key: true, hidden: true, active: true, setupFeeAgorot: true },
  });
  if (!plan) {
    return { state: failure('admin:errors.validation', [
      { field: 'planKey', messageKey: 'admin:errors.unknownPlan' },
    ]) };
  }

  /**
   * The offered-plan restriction, re-checked on the server (invariant 2: never let a route trust
   * the client about availability).
   *
   * The creation form's `<select>` is already filtered to `!hidden && active`, but `planKey`
   * arrives as free-form text in the POST body. A replayed form naming the hidden `demo` plan
   * sailed past every remaining check — `assertPeriodEndAllowed` only rejects a NULL period end
   * on a *visible* plan — and `billing.createAccount` sets `isDemo: plan.hidden`. The result was
   * a paying merchant behind proxy.ts's demo-token gate, force-noindexed, with the ₪350 setup fee
   * skipped, and their tenant eligible for B3's close-demo, which deletes it outright.
   *
   * A deactivated plan is refused for the plainer reason that it is not for sale.
   */
  if (plan.hidden) {
    return { state: failure('admin:errors.validation', [
      { field: 'planKey', messageKey: 'admin:errors.planNotOffered' },
    ]) };
  }
  if (!plan.active) {
    return { state: failure('admin:errors.validation', [
      { field: 'planKey', messageKey: 'admin:errors.planInactive' },
    ]) };
  }

  if (!isTemplateKey(input.templateKey)) {
    return { state: failure('admin:errors.validation', [
      { field: 'templateKey', messageKey: 'admin:errors.unknownTemplate' },
    ]) };
  }

  const allowedTemplates = await planTemplatesAllowed(ctx, plan.id);
  const singleTemplatePlan = allowedTemplates.length === 1;

  // A plan that permits exactly one template lets the admin choose WHICH one at onboarding —
  // that is what the per-tenant override is for. A plan that permits several does not.
  if (!singleTemplatePlan && !allowedTemplates.includes(input.templateKey)) {
    return { state: failure('admin:errors.validation', [
      { field: 'templateKey', messageKey: 'admin:errors.unknownTemplate' },
    ]) };
  }

  const existingUser = await authDb().user.findUnique({
    where: { email: input.ownerEmail },
    select: { id: true },
  });
  if (existingUser) {
    return { state: failure('admin:errors.validation', [
      { field: 'ownerEmail', messageKey: 'admin:errors.emailTaken' },
    ]) };
  }

  /**
   * The owner is created WITHOUT a credential account.
   *
   * `resetPassword` creates the credential row the first time the merchant sets a password, so
   * the only way into this account is a link we sent to an address the platform owner typed —
   * never a password a third party chose on the merchant's behalf and then knew.
   */
  const owner = await authDb().user.create({
    data: {
      email: input.ownerEmail,
      name: input.ownerName,
      emailVerified: true,
      platformRole: 'user',
    },
    select: { id: true },
  });

  /**
   * The owner row is written OUTSIDE billing's transaction, because `createAccount` needs a user
   * id to attach the membership to. So if billing then throws — a slug lost to a race, any DB
   * error — the user survives with the merchant's email on it, and the `emailTaken` pre-check
   * above refuses the operator's very next retry. Permanently: a user with no membership appears
   * on no admin page, so there is no screen in the panel that can free that address again.
   *
   * `discardOrphanOwner` removes it, and only ever a user that belongs to NO tenant — if the
   * failure landed after billing's tenant insert had committed, that user is a real owner and
   * deleting them would turn a half-built account into an unowned one.
   */
  let result;
  try {
    result = await billing.createAccount({
      tenantName: input.name,
      slug: input.slug,
      planKey: plan.key,
      billingPeriod: input.billingPeriod,
      currentPeriodEnd: input.currentPeriodEnd,
      owner: { userId: owner.id },
      templateKey: input.templateKey,
      site: {
        name: input.name,
        address: input.address,
        whatsapp: input.whatsapp,
        phone: input.phone,
      },
      actor: ctx.actor,
    });
  } catch (error) {
    await discardOrphanOwner(ctx, owner.id);
    throw error;
  }

  const tenantId = result.tenantId;

  if (singleTemplatePlan) {
    const { setFeatureOverride } = await import('./access');
    await setFeatureOverride(ctx, tenantId, 'templates_allowed', [input.templateKey]);
  }

  const analyticsProvisioned = await provisionAccountAnalytics(ctx, tenantId, {
    name: input.name,
    slug: input.slug,
  });

  let passwordLinkSent = false;
  if (input.sendPasswordLink) {
    passwordLinkSent = await sendOwnerPasswordLink(ctx, tenantId, input.ownerEmail);
  }

  await auditTenantAction(ctx, tenantId, {
    action: 'account.created',
    entityType: 'tenant',
    entityId: tenantId,
    after: {
      name: input.name,
      slug: input.slug,
      planKey: plan.key,
      billingPeriod: input.billingPeriod,
      currentPeriodEnd: input.currentPeriodEnd.toISOString(),
      templateKey: input.templateKey,
      setupFeeRecorded: result.setupFeePaymentId !== null,
    },
  });

  await auditPlatformAction(ctx, {
    action: 'account.created',
    entityType: 'tenant',
    entityId: tenantId,
    tenantRef: tenantId,
    after: { slug: input.slug, planKey: plan.key, billingPeriod: input.billingPeriod },
  });

  return {
    outcome: {
      tenantId,
      setupFeeRecorded: result.setupFeePaymentId !== null,
      analyticsProvisioned,
      passwordLinkSent,
    },
  };
}

/**
 * Undo the owner row after a failed `billing.createAccount`, so the operator can retry.
 *
 * Deletes ONLY a user that belongs to no tenant. A membership means billing's transaction did
 * commit and this is a real owner — removing them would leave a live account nobody owns, which
 * is worse than the taken email this exists to release. Failure to clean up is logged, never
 * raised: the caller is already unwinding a more important error and must not lose it.
 */
async function discardOrphanOwner(ctx: AdminContext, userId: string): Promise<void> {
  try {
    const memberships = await ctx.db.member.count({ where: { userId } });
    if (memberships > 0) return;
    await authDb().user.delete({ where: { id: userId } });
  } catch (error) {
    logger().warn(
      { err: error instanceof Error ? error.name : 'unknown' },
      'orphan owner could not be removed after a failed account creation',
    );
  }
}

async function planTemplatesAllowed(ctx: AdminContext, planId: string): Promise<string[]> {
  const row = await ctx.db.planFeature.findUnique({
    where: { planId_featureKey: { planId, featureKey: 'templates_allowed' satisfies FeatureKey } },
    select: { value: true },
  });

  const value = row?.value;
  if (Array.isArray(value)) return value.filter((key): key is string => typeof key === 'string');
  return [...TEMPLATE_KEYS];
}

/**
 * Create (or repair) the tenant's analytics website and store its id on `Site`.
 *
 * Returns whether an id ended up stored. Called at creation and again from a retry button,
 * because a reporting service being down at 9am must not mean an account is permanently
 * un-instrumented.
 */
export async function provisionAccountAnalytics(
  ctx: AdminContext,
  tenantId: string,
  tenant?: { name: string; slug: string },
): Promise<boolean> {
  const site = await ctx.db.site.findUnique({
    where: { tenantId },
    select: { id: true, umamiWebsiteId: true, tenant: { select: { name: true, slug: true } } },
  });
  if (!site) return false;
  if (site.umamiWebsiteId) return true;

  const identity = tenant ?? site.tenant;
  const websiteId = await provisionAnalyticsWebsite({
    name: identity.name,
    domain: storefrontHost(identity.slug),
  });

  if (!websiteId) return false;

  await ctx.db.site.update({ where: { tenantId }, data: { umamiWebsiteId: websiteId } });
  await auditTenantAction(ctx, tenantId, {
    action: 'account.analytics_provisioned',
    entityType: 'site',
    entityId: site.id,
    after: { umamiWebsiteId: websiteId },
  });

  logger().info({ tenantId }, 'analytics website provisioned');
  return true;
}

/** Sends the merchant an Arabic link to set their own password. Never reveals a password. */
export async function sendOwnerPasswordLink(
  ctx: AdminContext,
  tenantId: string,
  email: string,
): Promise<boolean> {
  /**
   * Rate limited HERE, because better-auth's own limiter cannot see this call (Phase 6).
   *
   * `auth().api.requestPasswordReset(...)` invokes the endpoint FUNCTION directly. better-auth
   * runs `onRequestRateLimit` from its HTTP router's `onRequest` hook and nowhere else, so a
   * server-side call bypasses every rule declared in the auth config — including the one this
   * function's own neighbours describe as protecting it. Without this, a merchant could mail-bomb
   * a staff address and burn the platform's Resend quota with a button, unthrottled.
   *
   * Keyed on the RECIPIENT, hashed: the harm is measured in mail delivered to one inbox, and the
   * key must not become a list of the platform's email addresses in a datastore that is backed up.
   */
  const allowed = await consumeSlot({
    key: `auth:reset-mail:${hmac('reset-mail', email.trim().toLowerCase())}`,
    limit: getEnv().RATE_LIMIT_LOGIN_PER_15MIN,
    windowSeconds: 900,
  });
  if (!allowed.allowed) {
    logger().warn({}, 'password link refused by the per-recipient rate limit');
    return false;
  }

  try {
    const { auth } = await import('@/server/auth');
    await auth().api.requestPasswordReset({
      body: {
        email,
        redirectTo: absoluteUrl(platformHost('app'), '/reset-password'),
      },
    });

    await auditTenantAction(ctx, tenantId, {
      action: 'account.password_link_sent',
      entityType: 'user',
      after: { sent: true },
    });

    return true;
  } catch (error) {
    logger().warn({ tenantId, error: (error as Error).message }, 'password link send failed');
    return false;
  }
}

// -----------------------------------------------------------------------------
// Lifecycle — thin wrappers over src/server/billing (invariant 5)
// -----------------------------------------------------------------------------

/**
 * Every lifecycle call funnels through here so the panel reports a refused transition as
 * Arabic copy rather than a stack trace, and so nobody is tempted to "handle" an
 * InvalidTransitionError by writing the row directly.
 */
async function runTransition(
  ctx: AdminContext,
  tenantId: string,
  action: string,
  run: () => Promise<unknown>,
  auditAfter: () => Record<string, unknown>,
): Promise<ActionState | null> {
  try {
    await run();
  } catch (error) {
    if (error instanceof InvalidTransitionError) {
      return failure('admin:subscription.notAllowedFromStatus');
    }
    throw error;
  }

  await auditTenantAction(ctx, tenantId, {
    action,
    entityType: 'subscription',
    entityId: tenantId,
    after: auditAfter(),
  });

  return null;
}

export async function extendAccount(
  ctx: AdminContext,
  tenantId: string,
  periods: number,
): Promise<ActionState | null> {
  if (!Number.isInteger(periods) || periods < 1 || periods > 24) {
    return failure('admin:errors.validation', [
      { field: 'periods', messageKey: 'admin:errors.invalidNumber' },
    ]);
  }

  let currentPeriodEnd: Date | undefined;
  const state = await runTransition(
    ctx,
    tenantId,
    'subscription.extended',
    async () => {
      ({ currentPeriodEnd } = await billing.extend(tenantId, { periods }));
    },
    () => ({ periods, currentPeriodEnd: currentPeriodEnd?.toISOString() }),
  );

  return state;
}

export async function suspendAccount(
  ctx: AdminContext,
  tenantId: string,
): Promise<ActionState | null> {
  // billing.suspend writes its own `subscription.suspended` audit row as the system actor; this
  // one records that a PERSON pressed the button, with their IP. Both matter, for different
  // questions.
  return runTransition(
    ctx,
    tenantId,
    'subscription.suspended',
    () => billing.suspend(tenantId, { reason: 'admin_action' }),
    () => ({ by: 'super_admin' }),
  );
}

export async function reactivateAccount(
  ctx: AdminContext,
  tenantId: string,
  currentPeriodEnd: Date,
): Promise<ActionState | null> {
  return runTransition(
    ctx,
    tenantId,
    'subscription.reactivated',
    () => billing.reactivate(tenantId, { currentPeriodEnd }),
    () => ({ currentPeriodEnd: currentPeriodEnd.toISOString() }),
  );
}

export async function extendAccountRetention(
  ctx: AdminContext,
  tenantId: string,
  days: number,
): Promise<ActionState | null> {
  if (!Number.isInteger(days) || days < 1 || days > 365) {
    return failure('admin:errors.validation', [
      { field: 'days', messageKey: 'admin:errors.invalidNumber' },
    ]);
  }

  return runTransition(
    ctx,
    tenantId,
    'subscription.retention_extended',
    () => billing.extendRetention(tenantId, { days, actor: ctx.actor }),
    () => ({ days }),
  );
}

/**
 * Permanent deletion.
 *
 * The choreography (quiesce, sweep R2, tombstone, cascade) belongs to `billing.purgeTenant`,
 * which B1 implements — so this calls it and reports honestly when it is not there yet. The
 * alternative, deleting the tenant row from here, would skip the R2 sweep and leave a
 * merchant's entire image library on object storage with nothing left that knows it exists.
 *
 * The platform audit row is written BEFORE the call, on the global table, because a tenant-owned
 * audit row would be destroyed by the very cascade it describes.
 */
export async function purgeAccount(
  ctx: AdminContext,
  tenantId: string,
  confirmation: { slug: string; typed: string },
): Promise<ActionState | null> {
  if (confirmation.typed.trim() !== confirmation.slug) {
    return failure('admin:subscription.purgeConfirmMismatch');
  }

  await auditPlatformAction(ctx, {
    action: 'subscription.purge_requested',
    entityType: 'tenant',
    entityId: tenantId,
    tenantRef: tenantId,
    before: { slug: confirmation.slug },
  });

  try {
    await billing.purgeTenant({
      tenantId,
      reason: 'super_admin_purge',
      purgedById: ctx.userId,
    });
  } catch (error) {
    if (error instanceof InvalidTransitionError) {
      return failure('admin:subscription.notAllowedFromStatus');
    }
    throw error;
  }

  return null;
}
