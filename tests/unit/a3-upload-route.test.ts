import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * A3 — the upload route's own gate.
 *
 * `/api/**` is UNPREFIXED: it answers on every hostname, so the handler cannot infer its surface
 * from the path and has to establish everything itself. These cases check the four refusals that
 * happen BEFORE the pipeline is reached — the ones a merchant sees most often and the ones an
 * attacker probes first.
 *
 * The session layer is mocked because better-auth needs a database and these are unit tests; the
 * pipeline itself is exercised for real in tests/integration/a3-media-pipeline.test.ts.
 */

const { session, access } = vi.hoisted(() => ({
  session: { current: null as unknown },
  access: { allowed: true },
}));

vi.mock('@/server/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/auth')>();
  return {
    ...actual,
    getSession: vi.fn(async () => session.current),
    checkMerchantAccess: vi.fn(async () => access),
  };
});

import type { NextRequest } from 'next/server';
import { POST } from '@/app/api/media/upload/route';
import { TENANT_HEADERS } from '@/server/tenancy';

const ARABIC = /[؀-ۿ]/;

function merchantSession(memberRole: 'owner' | 'staff' = 'owner') {
  return {
    user: {
      id: 'usr_1',
      email: 'owner@souqbartaa.test',
      name: 'صاحب المتجر',
      emailVerified: true,
      platformRole: 'user' as const,
      twoFactorEnabled: false,
    },
    tenantId: 'tnt_1',
    memberRole,
    impersonatedBy: null,
  };
}

function request(options: {
  surface?: string;
  contentType?: string;
  contentLength?: number;
  body?: BodyInit;
}): NextRequest {
  const headers = new Headers();
  headers.set('content-type', options.contentType ?? 'multipart/form-data; boundary=x');
  headers.set(TENANT_HEADERS.surface, options.surface ?? 'app');
  if (options.contentLength !== undefined) {
    headers.set('content-length', String(options.contentLength));
  }

  return new Request('http://app.souqbartaa.test/api/media/upload', {
    method: 'POST',
    headers,
    body: options.body,
  }) as unknown as NextRequest;
}

async function readBody(response: Response): Promise<{ ok: boolean; code: string; message: string }> {
  return (await response.json()) as { ok: boolean; code: string; message: string };
}

afterEach(() => {
  session.current = null;
  access.allowed = true;
});

describe('the upload endpoint refuses before it reads a body', () => {
  it('rejects a body larger than any plan allows, without buffering it', async () => {
    session.current = merchantSession();
    const response = await POST(request({ contentLength: 40 * 1024 * 1024 }));
    const body = await readBody(response);

    expect(response.status).toBe(413);
    expect(body.code).toBe('tooLargeForServer');
    expect(body.message).toMatch(ARABIC);
  });

  it('rejects a request that is not a form upload at all', async () => {
    session.current = merchantSession();
    const response = await POST(request({ contentType: 'application/json' }));

    expect(response.status).toBe(400);
    expect((await readBody(response)).code).toBe('noFile');
  });
});

describe('the upload endpoint establishes its own caller', () => {
  it('refuses an anonymous request in Arabic', async () => {
    const response = await POST(request({}));
    const body = await readBody(response);

    expect(response.status).toBe(401);
    expect(body.code).toBe('unauthorized');
    expect(body.message).toMatch(ARABIC);
  });

  it('refuses a session with no tenant membership', async () => {
    session.current = { ...merchantSession(), tenantId: null, memberRole: null };
    const response = await POST(request({}));

    expect(response.status).toBe(403);
    expect((await readBody(response)).code).toBe('forbidden');
  });

  it('refuses an authenticated upload arriving on a STOREFRONT hostname', async () => {
    // `/api/**` answers on every hostname, so the surface has to be checked rather than assumed.
    session.current = merchantSession();
    const response = await POST(request({ surface: 'storefront' }));

    expect(response.status).toBe(403);
  });

  it('refuses when RBAC denies the media scope', async () => {
    session.current = merchantSession('staff');
    access.allowed = false;
    const response = await POST(request({}));

    expect(response.status).toBe(403);
    expect((await readBody(response)).code).toBe('forbidden');
  });

  it('refuses a form with no file part', async () => {
    session.current = merchantSession();
    const form = new FormData();
    form.set('altText', 'وصف بدون صورة');

    const response = await POST(
      new Request('http://app.souqbartaa.test/api/media/upload', {
        method: 'POST',
        headers: { [TENANT_HEADERS.surface]: 'app' },
        body: form,
      }) as unknown as NextRequest,
    );

    expect(response.status).toBe(400);
    expect((await readBody(response)).code).toBe('noFile');
  });
});
