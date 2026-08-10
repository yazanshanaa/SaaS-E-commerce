import { getEnv } from '@/env';
import { logger } from '@/server/logger';

/**
 * The self-hosted analytics service (CLAUDE.md's stack: one websiteId per tenant).
 *
 * Two jobs, both optional at runtime:
 *   - provision a website at account creation and store its id on `Site.umamiWebsiteId`,
 *   - read a visit count for the account page.
 *
 * EVERYTHING HERE DEGRADES. A developer checkout has no analytics container, and a production
 * outage in a reporting service must never be able to stop a super admin from opening an
 * account — so provisioning failure is reported and retryable rather than fatal, and a failed
 * read renders an Arabic "not available right now" instead of an error page. `createAccount`
 * calls this AFTER the tenant exists for exactly that reason.
 *
 * Credentials come from env and are never logged: the logger redacts `token`, and nothing here
 * puts a username or password in a log line either.
 */

const REQUEST_TIMEOUT_MS = 8_000;
const TOKEN_TTL_MS = 25 * 60 * 1000;

export interface AnalyticsConfig {
  baseUrl: string;
  token?: string;
  username?: string;
  password?: string;
}

export function analyticsConfig(): AnalyticsConfig | null {
  const env = getEnv();
  if (!env.UMAMI_BASE_URL) return null;

  const hasCredentials =
    Boolean(env.UMAMI_API_TOKEN) || Boolean(env.UMAMI_API_USERNAME && env.UMAMI_API_PASSWORD);
  if (!hasCredentials) return null;

  return {
    baseUrl: env.UMAMI_BASE_URL.replace(/\/+$/, ''),
    token: env.UMAMI_API_TOKEN,
    username: env.UMAMI_API_USERNAME,
    password: env.UMAMI_API_PASSWORD,
  };
}

export function isAnalyticsConfigured(): boolean {
  return analyticsConfig() !== null;
}

let cachedToken: { value: string; expiresAt: number } | undefined;

/** Test seam: the integration suite must not carry a token across cases. */
export function resetAnalyticsTokenCache(): void {
  cachedToken = undefined;
}

async function bearerToken(config: AnalyticsConfig): Promise<string | null> {
  if (config.token) return config.token;

  if (cachedToken && cachedToken.expiresAt > Date.now()) return cachedToken.value;
  if (!config.username || !config.password) return null;

  const response = await fetch(`${config.baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: config.username, password: config.password }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    cache: 'no-store',
  });

  if (!response.ok) return null;

  const body = (await response.json()) as { token?: string };
  if (!body.token) return null;

  cachedToken = { value: body.token, expiresAt: Date.now() + TOKEN_TTL_MS };
  return body.token;
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T | null> {
  const config = analyticsConfig();
  if (!config) return null;

  try {
    const token = await bearerToken(config);
    if (!token) return null;

    const response = await fetch(`${config.baseUrl}${path}`, {
      ...init,
      headers: {
        ...(init.headers ?? {}),
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      cache: 'no-store',
    });

    if (!response.ok) {
      logger().warn({ path, status: response.status }, 'analytics request failed');
      return null;
    }

    return (await response.json()) as T;
  } catch (error) {
    logger().warn({ path, error: (error as Error).message }, 'analytics request errored');
    return null;
  }
}

/**
 * Create the tenant's website record and return its id.
 *
 * `null` means "not configured, or it did not work" — the caller stores nothing and the account
 * page offers a retry. It deliberately does not throw: a reporting service is not allowed to
 * fail an account creation that has already written a tenant, a subscription and a payment.
 */
export async function provisionAnalyticsWebsite(input: {
  name: string;
  domain: string;
}): Promise<string | null> {
  const created = await call<{ id?: string; websiteId?: string }>('/api/websites', {
    method: 'POST',
    body: JSON.stringify({ name: input.name, domain: input.domain }),
  });

  return created?.id ?? created?.websiteId ?? null;
}

export interface VisitStats {
  visitors: number;
  pageviews: number;
  /** How many days the window covers, so the UI can say what the number means. */
  days: number;
}

/** Visits over the last `days`. `null` on any failure — the UI says so rather than showing 0. */
export async function websiteVisits(websiteId: string, days = 30): Promise<VisitStats | null> {
  const endAt = Date.now();
  const startAt = endAt - days * 24 * 60 * 60 * 1000;

  const stats = await call<{
    visitors?: { value?: number };
    pageviews?: { value?: number };
  }>(`/api/websites/${encodeURIComponent(websiteId)}/stats?startAt=${startAt}&endAt=${endAt}`);

  if (!stats) return null;

  return {
    visitors: stats.visitors?.value ?? 0,
    pageviews: stats.pageviews?.value ?? 0,
    days,
  };
}
