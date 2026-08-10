import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  INTERNAL_SECRET_HEADER,
  internalRevalidateUrl,
  requestStorefrontRevalidation,
  wantsStorefrontRevalidation,
} from '@/server/revalidation';
import { resetEnvCache } from '@/env';

/**
 * The Group A merge left one thing open and named Group B as its owner: `revalidateStorefront()`
 * is `revalidateTag()`, which throws outside a Next-managed context — so the queue, where A3's
 * image pipeline finishes a variant, could not call the very function the caching contract tells
 * it to call.
 *
 * These cases pin the two halves of the fix: the worker takes the HTTP door, and a failure on
 * that door never propagates to the caller (the job has already committed; retrying it would
 * redo minutes of image processing).
 */

const originalRuntime = process.env.NEXT_RUNTIME;
const originalBase = process.env.INTERNAL_BASE_URL;
const originalSecret = process.env.INTERNAL_API_SECRET;

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

beforeEach(() => {
  // The worker container is not the Next server. That is precisely the case that was broken.
  delete process.env.NEXT_RUNTIME;
  resetEnvCache();
});

afterEach(() => {
  restore('NEXT_RUNTIME', originalRuntime);
  restore('INTERNAL_BASE_URL', originalBase);
  restore('INTERNAL_API_SECRET', originalSecret);
  resetEnvCache();
  vi.unstubAllGlobals();
});

describe('internalRevalidateUrl', () => {
  it('builds the endpoint from INTERNAL_BASE_URL and tolerates a trailing slash', () => {
    process.env.INTERNAL_BASE_URL = 'http://web:3000/';
    resetEnvCache();
    expect(internalRevalidateUrl()).toBe('http://web:3000/internal/revalidate');
  });

  it('defaults to the local web server, so a dev worker works with no configuration', () => {
    delete process.env.INTERNAL_BASE_URL;
    resetEnvCache();
    expect(internalRevalidateUrl()).toBe('http://127.0.0.1:3000/internal/revalidate');
  });
});

describe('requestStorefrontRevalidation outside the Next server', () => {
  it('POSTs the tenant id to /internal/revalidate and reports success', async () => {
    process.env.INTERNAL_BASE_URL = 'http://web:3000';
    delete process.env.INTERNAL_API_SECRET;
    resetEnvCache();

    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(requestStorefrontRevalidation('tenant_1')).resolves.toBe(true);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://web:3000/internal/revalidate');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ tenantId: 'tenant_1' });
  });

  it('presents the shared secret when one is configured, and omits the header when none is', async () => {
    process.env.INTERNAL_API_SECRET = 'sekrit-value';
    resetEnvCache();

    const withSecret = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', withSecret);
    await requestStorefrontRevalidation('tenant_1');

    const [, signedInit] = withSecret.mock.calls[0] as unknown as [string, RequestInit];
    expect((signedInit.headers as Record<string, string>)[INTERNAL_SECRET_HEADER]).toBe(
      'sekrit-value',
    );

    delete process.env.INTERNAL_API_SECRET;
    resetEnvCache();

    const withoutSecret = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', withoutSecret);
    await requestStorefrontRevalidation('tenant_1');

    const [, plainInit] = withoutSecret.mock.calls[0] as unknown as [string, RequestInit];
    expect((plainInit.headers as Record<string, string>)[INTERNAL_SECRET_HEADER]).toBeUndefined();
  });

  it('swallows a transport failure — the job that asked for this has already committed', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
    );

    await expect(requestStorefrontRevalidation('tenant_1')).resolves.toBe(false);
  });

  it('treats a non-2xx answer as a failure rather than a silent success', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 401 })));

    await expect(requestStorefrontRevalidation('tenant_1')).resolves.toBe(false);
  });
});

describe('wantsStorefrontRevalidation', () => {
  it('recognises the marker a processor returns, and nothing else', () => {
    expect(wantsStorefrontRevalidation({ revalidateStorefront: true })).toBe(true);
    expect(wantsStorefrontRevalidation({ revalidateStorefront: false })).toBe(false);
    // A truthy-but-not-true value must not count: the flag is a contract, not a hint.
    expect(wantsStorefrontRevalidation({ revalidateStorefront: 'yes' })).toBe(false);
    expect(wantsStorefrontRevalidation({ status: 'ready' })).toBe(false);
    expect(wantsStorefrontRevalidation(null)).toBe(false);
    expect(wantsStorefrontRevalidation(undefined)).toBe(false);
    expect(wantsStorefrontRevalidation('revalidateStorefront')).toBe(false);
  });
});
