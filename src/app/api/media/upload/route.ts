import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { actorFromSession, getSession, checkMerchantAccess } from '@/server/auth';
import { logger } from '@/server/logger';
import { readRequestTenant } from '@/server/tenancy';
import type { MessageParams } from '@/shared/i18n';
import {
  ABSOLUTE_MAX_UPLOAD_BYTES,
  MAX_ALT_LENGTH,
  MediaError,
  consumeUploadSlot,
  isMediaError,
  uploadMedia,
  type MediaErrorCode,
} from '@/server/media';

/**
 * POST /api/media/upload — the merchant's image upload.
 *
 * `/api/**` is UNPREFIXED: it answers on every hostname, so this handler cannot infer its
 * surface from the path. It therefore establishes everything itself, in this order:
 *
 *   1. zod over the request envelope, before a byte of the body is read,
 *   2. the SESSION decides the tenant — never a header, never a field in the form. The proxy's
 *      resolved context is read only to refuse a storefront hostname, which has no business
 *      carrying an authenticated upload,
 *   3. RBAC: `media` is a scope `staff` legitimately holds (Q13), so the check is
 *      `checkMerchantAccess`, not "is this an owner",
 *   4. the pipeline, which does the magic bytes, both plan limits and the rate limit.
 *
 * Every message a human sees comes from `messages/ar/media.json` through `t()`.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * A plan-independent ceiling. The per-plan limit (2 / 5 / 10MB) is checked afterwards against the
 * real byte count; this one exists so an oversized body cannot be held in memory while we work
 * out who is asking.
 *
 * It is enforced TWICE, and the second time is the one that matters. `content-length` is optional
 * here because a client decides whether to send it: `Transfer-Encoding: chunked` with no declared
 * length parses clean through this schema. Trusting the header alone would leave
 * `request.formData()` free to materialise an arbitrary payload — twice, once for the form and
 * once for `arrayBuffer()` — before a single limit ran. Nothing else caps it either: the Caddyfile
 * sets no `request_body max_size`, and the App Router applies no body limit to a Node-runtime
 * route handler (`bodySizeLimit` covers server actions and the Pages API, not this). So the body
 * is read through a counting reader that stops at the ceiling.
 */
const envelopeSchema = z.object({
  contentType: z
    .string()
    .min(1)
    .refine((value) => value.toLowerCase().includes('multipart/form-data')),
  contentLength: z
    .number()
    .int()
    .nonnegative()
    .max(ABSOLUTE_MAX_UPLOAD_BYTES)
    .optional(),
});

/**
 * A declared length is an OPTIMISATION, so a malformed one must not become a verdict.
 *
 * `Headers.get` joins duplicate headers into `"100, 100"` and `Number()` turns anything
 * unparseable into NaN. Handing that to zod produced an issue on `contentLength`, which the
 * handler read as "too large" — answering 413 «الملف أكبر من الحد الأقصى» to a 100-byte request
 * and telling the merchant to shrink a photo that was never too big. An unusable header simply
 * means we do not know the length yet; the stream ceiling is the real bound either way.
 */
function declaredLength(raw: string | null): number | undefined {
  if (raw === null) return undefined;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

const formSchema = z.object({
  altText: z.string().trim().max(300).optional(),
});

/**
 * Read the request body, refusing to hold more than `limit` bytes.
 *
 * Returns null the moment the total crosses the ceiling, so the peak memory is one chunk past the
 * bound rather than whatever the client felt like sending. The stream is cancelled on the way out
 * so the connection is not left half-drained.
 */
/** A client that hung up mid-upload. Routine on 3G; never a server fault. */
class ClientDisconnected extends Error {}

async function readCappedBody(request: NextRequest, limit: number): Promise<Blob | null> {
  const stream = request.body;
  if (!stream) return new Blob([]);

  const reader = stream.getReader();
  const chunks: BlobPart[] = [];
  let total = 0;

  try {
    for (;;) {
      let chunk;
      try {
        chunk = await reader.read();
      } catch (error) {
        // The socket died under us: the tab closed, the phone lost signal, the merchant
        // navigated away. Letting this propagate turns every cancelled upload into a 500 and a
        // Sentry alert indistinguishable from a real fault.
        throw new ClientDisconnected((error as Error).message);
      }

      const { done, value } = chunk;
      if (done) break;
      if (!value) continue;

      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(new Uint8Array(value));
    }
  } finally {
    reader.releaseLock();
  }

  return new Blob(chunks);
}

/**
 * `params` is not optional decoration: `altTooLong` interpolates `{max}`, and answering without
 * it told the merchant to shorten their description to «{max}» characters.
 */
function fail(code: MediaErrorCode, params?: MessageParams) {
  const error = new MediaError(code, params);
  return NextResponse.json(
    { ok: false, code: error.code, message: error.arabicMessage },
    { status: error.httpStatus },
  );
}

export async function POST(request: NextRequest): Promise<Response> {
  const envelope = envelopeSchema.safeParse({
    contentType: request.headers.get('content-type') ?? '',
    contentLength: declaredLength(request.headers.get('content-length')),
  });

  if (!envelope.success) {
    // Either it is not a form upload at all, or it is larger than anything any plan allows. The
    // per-plan message names the plan's own number; this one cannot, because we have not yet
    // established which tenant is asking.
    const tooLarge = envelope.error.issues.some((issue) => issue.path[0] === 'contentLength');
    return fail(tooLarge ? 'tooLargeForServer' : 'noFile');
  }

  const session = await getSession(request.headers);
  if (!session) return fail('unauthorized');
  if (!session.tenantId || !session.memberRole) return fail('forbidden');

  // A storefront hostname never carries an authenticated upload. Refusing here keeps the API
  // reachable from the dashboard and from an impersonated admin session, and nowhere else.
  const surface = readRequestTenant(request.headers).surface;
  if (surface !== 'app' && surface !== 'admin') return fail('forbidden');

  const access = await checkMerchantAccess(session.tenantId, session.memberRole, 'media');
  if (!access.allowed) return fail('forbidden');

  /**
   * The rate limit is charged BEFORE the body is buffered, and that ordering is the point.
   *
   * Charging it inside `uploadMedia` — after the read — meant a caller over budget still made
   * the server hold 25MB first, and could repeat immediately at no cost to itself: the 429 was
   * an answer, not a bound. One authenticated account could keep the web container at several
   * copies of 25MB per in-flight request (the Blob, the parsed File, the Buffer) for as long as
   * it liked. Refusing here costs one Redis round trip and reads nothing.
   */
  const slot = await consumeUploadSlot(session.tenantId, { headers: request.headers });
  if (!slot.allowed) return fail('rateLimited');

  // The real ceiling: bounded regardless of what the client declared, or did not declare.
  let raw: Blob | null;
  try {
    raw = await readCappedBody(request, ABSOLUTE_MAX_UPLOAD_BYTES);
  } catch (error) {
    if (error instanceof ClientDisconnected) {
      logger().info({ tenantId: session.tenantId }, 'media upload abandoned by the client');
      return fail('noFile');
    }
    throw error;
  }
  if (raw === null) return fail('tooLargeForServer');

  let form: FormData;
  try {
    // Re-parsed from bytes we have already bounded. `Response` is the multipart parser the
    // runtime already ships; handing it a Buffer is what keeps the cap in front of it.
    form = await new Response(raw, {
      headers: { 'content-type': envelope.data.contentType },
    }).formData();
  } catch {
    return fail('noFile');
  }

  const file = form.get('file');
  if (!(file instanceof File)) return fail('noFile');

  // A `File` in the alt field is a malformed request, not a description that is too long, so it
  // is narrowed to a string first — leaving `too_big` as the only way the parse can fail.
  const rawAlt = form.get('altText');
  const fields = formSchema.safeParse({
    altText: typeof rawAlt === 'string' ? rawAlt : undefined,
  });
  if (!fields.success) return fail('altTooLong', { max: MAX_ALT_LENGTH });

  const body = Buffer.from(await file.arrayBuffer());

  try {
    const result = await uploadMedia({
      tenantId: session.tenantId,
      body,
      actor: actorFromSession(session),
      fileName: file.name || undefined,
      declaredContentType: file.type || undefined,
      altText: fields.data.altText,
    });

    return NextResponse.json(
      { ok: true, mediaId: result.mediaId, status: result.status, sizeBytes: result.sizeBytes },
      { status: 202 },
    );
  } catch (error) {
    if (isMediaError(error)) {
      return NextResponse.json(
        { ok: false, code: error.code, message: error.arabicMessage },
        { status: error.httpStatus },
      );
    }

    logger().error({ error: (error as Error).message }, 'media upload failed');
    return fail('server');
  }
}
