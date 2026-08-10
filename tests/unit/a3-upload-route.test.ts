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

const { session, access, uploads } = vi.hoisted(() => ({
  session: { current: null as unknown },
  access: { allowed: true },
  uploads: [] as Array<{ sizeBytes: number; altText?: string }>,
}));

vi.mock('@/server/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/auth')>();
  return {
    ...actual,
    getSession: vi.fn(async () => session.current),
    checkMerchantAccess: vi.fn(async () => access),
  };
});

vi.mock('@/server/media', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/media')>();
  return {
    ...actual,
    // The pipeline itself is exercised for real in tests/integration/a3-media-pipeline.test.ts.
    // Here it stands in for "the route got this far, with these bytes".
    uploadMedia: vi.fn(async (input: { body: Buffer; altText?: string }) => {
      uploads.push({ sizeBytes: input.body.byteLength, altText: input.altText });
      return {
        mediaId: 'med_1',
        key: 'k',
        mimeType: 'image/jpeg',
        sizeBytes: input.body.byteLength,
        status: 'pending' as const,
      };
    }),
  };
});

import type { NextRequest } from 'next/server';
import { POST } from '@/app/api/media/upload/route';
import { ABSOLUTE_MAX_UPLOAD_BYTES } from '@/server/media';
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

/**
 * The same upload a browser makes, re-sent as a STREAM with no `content-length` — which is what
 * `Transfer-Encoding: chunked` looks like on the server side, and what any client can choose to
 * send. The declared-length check cannot see it.
 */
function streamedRequest(
  contentType: string,
  body: ReadableStream<Uint8Array>,
  surface = 'app',
): NextRequest {
  return new Request('http://app.souqbartaa.test/api/media/upload', {
    method: 'POST',
    headers: { 'content-type': contentType, [TENANT_HEADERS.surface]: surface },
    body,
    // Required by undici for a streaming request body; absent from the DOM RequestInit type.
    duplex: 'half',
  } as unknown as RequestInit) as unknown as NextRequest;
}

async function asStreamed(form: FormData): Promise<NextRequest> {
  const built = new Request('http://app.souqbartaa.test/api/media/upload', {
    method: 'POST',
    body: form,
  });
  const bytes = new Uint8Array(await built.arrayBuffer());
  const contentType = built.headers.get('content-type') ?? 'multipart/form-data';

  return streamedRequest(
    contentType,
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
  );
}

afterEach(() => {
  session.current = null;
  access.allowed = true;
  uploads.length = 0;
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

  it('caps a CHUNKED body that declares no length at all, and stops reading it', async () => {
    /**
     * The regression: the 25MB ceiling was enforced only against `content-length`, which is
     * optional and which the client chooses. A chunked body sailed past the envelope and was then
     * materialised twice — once by `formData()` and once by `arrayBuffer()` — before any limit
     * ran. Nothing else caps it: the Caddyfile sets no `request_body max_size`, and the App Router
     * applies no body limit to a Node-runtime route handler. One authenticated request could take
     * the web container down.
     */
    session.current = merchantSession();

    const chunk = new Uint8Array(1024 * 1024);
    const totalChunks = 64; // 64MB if it were ever read to the end.
    let produced = 0;

    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (produced >= totalChunks) {
          controller.close();
          return;
        }
        produced += 1;
        controller.enqueue(chunk);
      },
    });

    const response = await POST(
      streamedRequest('multipart/form-data; boundary=x', body),
    );

    expect(response.status).toBe(413);
    expect((await readBody(response)).code).toBe('tooLargeForServer');

    // It stopped at the ceiling instead of draining the client's 64MB into memory. The slack is
    // the stream's own read-ahead queue, which is the transport's buffer and not the handler's:
    // what the route itself ever held is the 25MB it counted before it gave up.
    expect(produced).toBeLessThan(totalChunks);
    expect(produced * chunk.byteLength).toBeLessThanOrEqual(
      ABSOLUTE_MAX_UPLOAD_BYTES + 4 * chunk.byteLength,
    );
    expect(uploads).toHaveLength(0);
  });

  it('still accepts a normal chunked upload that fits under the ceiling', async () => {
    // The cap must bound the body, not forbid streaming: a legitimate upload with no declared
    // length has to keep working.
    session.current = merchantSession();

    const form = new FormData();
    form.set('file', new File([new Uint8Array(4096)], 'shop.jpg', { type: 'image/jpeg' }));
    form.set('altText', 'واجهة المحل من الشارع');

    const response = await POST(await asStreamed(form));

    expect(response.status).toBe(202);
    expect(uploads).toHaveLength(1);
    expect(uploads[0]?.sizeBytes).toBe(4096);
    expect(uploads[0]?.altText).toBe('واجهة المحل من الشارع');
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

  it('calls an over-long description TOO LONG, not too short', async () => {
    // `formSchema` caps altText at 300; the route used to answer every failure of that parse with
    // `altTooShort` — «الوصف قصير. اكتب جملة...» for a description that was too long.
    session.current = merchantSession();

    const form = new FormData();
    form.set('file', new File([new Uint8Array(64)], 'shop.jpg', { type: 'image/jpeg' }));
    form.set('altText', 'قميص '.repeat(100));

    const response = await POST(await asStreamed(form));
    const body = await readBody(response);

    expect(response.status).toBe(422);
    expect(body.code).toBe('altTooLong');
    expect(body.message).toMatch(ARABIC);
    expect(uploads).toHaveLength(0);
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
