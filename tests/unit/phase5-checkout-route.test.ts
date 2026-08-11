import { afterEach, describe, expect, it, vi } from 'vitest';
import { TENANT_HEADERS } from '@/server/tenancy';

/**
 * The checkout endpoint's own gate.
 *
 * `/api/**` is UNPREFIXED — it answers on every hostname — so this handler establishes everything
 * itself, and these are the refusals that happen BEFORE an order can exist. They matter more here
 * than on any other route in the platform: this is the one unauthenticated write of customer PII,
 * and every rung of the ladder is the last line for something.
 *
 * The order service, entitlements and the database are mocked; the real thing is exercised in
 * `tests/integration/phase5-orders.test.ts`. What is NOT mocked is the gate itself.
 */

const { requestHeaders, features, gateway, site, placed } = vi.hoisted(() => ({
  requestHeaders: { current: new Headers() },
  features: { paymentGateway: true as unknown },
  gateway: { current: { provider: 'manual', enabled: true } as unknown },
  site: { sellingEnabled: true as boolean | undefined },
  placed: [] as Array<Record<string, unknown>>,
}));

vi.mock('next/headers', () => ({
  headers: async () => requestHeaders.current,
}));

vi.mock('@/server/entitlements', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/entitlements')>();
  return { ...actual, can: vi.fn(async () => features.paymentGateway) };
});

vi.mock('@/server/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/db')>();
  return {
    ...actual,
    tenantDb: vi.fn(() => ({
      site: { findUnique: async () => (site.sellingEnabled === undefined ? null : site) },
    })),
  };
});

vi.mock('@/server/payments', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/payments')>();
  return { ...actual, readEnabledGateway: vi.fn(async () => gateway.current) };
});

vi.mock('@/server/orders', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/orders')>();
  return {
    ...actual,
    placeOrder: vi.fn(async (input: Record<string, unknown>) => {
      placed.push(input);
      return { ok: true, orderId: 'ord_1', number: 7, totalAgorot: 5_000, currency: 'ILS' };
    }),
  };
});

import { POST } from '@/app/api/storefront/checkout/route';
import { placeOrder } from '@/server/orders';

const ARABIC = /[؀-ۿ]/;

const BODY = {
  productSlug: 'kanafa',
  quantity: 2,
  customerName: 'أحمد عودة',
  customerPhone: '0599123456',
};

function setContext(
  over: Partial<Record<'surface' | 'tenantId' | 'isDemo' | 'isSuspended' | 'hostname', string>> = {},
  extra: Record<string, string> = {},
) {
  const headers = new Headers();
  headers.set(TENANT_HEADERS.surface, over.surface ?? 'storefront');
  headers.set(TENANT_HEADERS.tenantId, over.tenantId ?? 'tnt_1');
  headers.set(TENANT_HEADERS.hostname, over.hostname ?? 'shop.souqbartaa.test');
  if (over.isDemo) headers.set(TENANT_HEADERS.isDemo, over.isDemo);
  if (over.isSuspended) headers.set(TENANT_HEADERS.isSuspended, over.isSuspended);
  headers.set('content-type', 'application/json');
  for (const [name, value] of Object.entries(extra)) headers.set(name, value);
  requestHeaders.current = headers;
}

function request(body: unknown = BODY): Request {
  return new Request('http://shop.souqbartaa.test/api/storefront/checkout', {
    method: 'POST',
    headers: requestHeaders.current,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

afterEach(() => {
  features.paymentGateway = true;
  gateway.current = { provider: 'manual', enabled: true };
  site.sellingEnabled = true;
  placed.length = 0;
  vi.mocked(placeOrder).mockClear();
});

describe('the checkout endpoint refuses before it writes anything', () => {
  it('404s on a surface that is not a storefront', async () => {
    setContext({ surface: 'app' });
    expect((await POST(request())).status).toBe(404);
    expect(placeOrder).not.toHaveBeenCalled();
  });

  it('404s when proxy.ts resolved no tenant', async () => {
    const headers = new Headers();
    headers.set(TENANT_HEADERS.surface, 'storefront');
    headers.set('content-type', 'application/json');
    requestHeaders.current = headers;

    expect((await POST(request())).status).toBe(404);
    expect(placeOrder).not.toHaveBeenCalled();
  });

  it('404s on a DEMO tenant — a prospect showcase never takes a real order', async () => {
    setContext({ isDemo: '1' });
    expect((await POST(request())).status).toBe(404);
    expect(placeOrder).not.toHaveBeenCalled();
  });

  it('404s on a SUSPENDED tenant — the storefront is closed', async () => {
    setContext({ isSuspended: '1' });
    expect((await POST(request())).status).toBe(404);
    expect(placeOrder).not.toHaveBeenCalled();
  });

  it('403s a cross-site post', async () => {
    setContext({}, { 'sec-fetch-site': 'cross-site' });
    expect((await POST(request())).status).toBe(403);
    expect(placeOrder).not.toHaveBeenCalled();
  });

  it('403s a post whose Origin names a SIBLING storefront', async () => {
    // `same-site` is not good enough: another tenant's shop is a sibling subdomain, and an order
    // written against the wrong tenant is the cross-tenant write invariant 1 exists to stop.
    setContext({}, { 'sec-fetch-site': 'same-site', origin: 'http://other.souqbartaa.test' });
    expect((await POST(request())).status).toBe(403);
  });

  it('415s anything that is not application/json', async () => {
    setContext({}, { 'content-type': 'text/plain' });
    expect((await POST(request())).status).toBe(415);
    expect(placeOrder).not.toHaveBeenCalled();
  });

  it('404s — and never calls the service — when payment_gateway is off', async () => {
    setContext();
    features.paymentGateway = false;

    const response = await POST(request());
    expect(response.status).toBe(404);
    expect(placeOrder).not.toHaveBeenCalled();
  });

  it('404s when the merchant has not switched selling on', async () => {
    setContext();
    site.sellingEnabled = false;

    expect((await POST(request())).status).toBe(404);
    expect(placeOrder).not.toHaveBeenCalled();
  });

  it('404s when no gateway row is enabled', async () => {
    setContext();
    gateway.current = null;

    expect((await POST(request())).status).toBe(404);
    expect(placeOrder).not.toHaveBeenCalled();
  });

  it('400s a malformed body', async () => {
    setContext();
    expect((await POST(request('not json'))).status).toBe(400);
    expect(placeOrder).not.toHaveBeenCalled();
  });

  it('400s a body that fails the schema', async () => {
    setContext();
    const response = await POST(request({ ...BODY, customerPhone: '12' }));
    expect(response.status).toBe(400);
    expect(placeOrder).not.toHaveBeenCalled();
  });
});

describe('the happy path', () => {
  it('places the order and answers with the NUMBER, never the id', async () => {
    setContext();
    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');

    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toEqual({ ok: true, number: 7 });
    expect(body.orderId).toBeUndefined();
  });

  it('passes the tenant from the CONTEXT and the price from nowhere at all', async () => {
    setContext();
    await POST(request({ ...BODY, totalAgorot: 1, tenantId: 'tnt_evil' }));

    expect(placed).toHaveLength(1);
    expect(placed[0]!.tenantId).toBe('tnt_1');
    // The client cannot name a price: the service reads it off the product row.
    expect(placed[0]).not.toHaveProperty('totalAgorot');
  });

  it('never puts Arabic in a response — copy lives in the catalogue, not in a route', async () => {
    setContext();
    const responses = [await POST(request())];

    features.paymentGateway = false;
    responses.push(await POST(request()));

    features.paymentGateway = true;
    responses.push(await POST(request({ ...BODY, customerName: '' })));

    for (const response of responses) {
      expect(await response.text()).not.toMatch(ARABIC);
    }
  });
});
