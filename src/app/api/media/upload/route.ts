import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { actorFromSession, getSession, checkMerchantAccess } from '@/server/auth';
import { logger } from '@/server/logger';
import { readRequestTenant } from '@/server/tenancy';
import {
  ABSOLUTE_MAX_UPLOAD_BYTES,
  MediaError,
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
 * A plan-independent ceiling, applied to the declared length BEFORE the body is buffered. The
 * per-plan limit (2 / 5 / 10MB) is checked afterwards against the real byte count — this one
 * exists so an oversized body cannot be held in memory while we work out who is asking.
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

const formSchema = z.object({
  altText: z.string().trim().max(300).optional(),
});

function fail(code: MediaErrorCode) {
  const error = new MediaError(code);
  return NextResponse.json(
    { ok: false, code: error.code, message: error.arabicMessage },
    { status: error.httpStatus },
  );
}

export async function POST(request: NextRequest): Promise<Response> {
  const envelope = envelopeSchema.safeParse({
    contentType: request.headers.get('content-type') ?? '',
    contentLength: request.headers.get('content-length')
      ? Number(request.headers.get('content-length'))
      : undefined,
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

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return fail('noFile');
  }

  const file = form.get('file');
  if (!(file instanceof File)) return fail('noFile');

  const fields = formSchema.safeParse({ altText: form.get('altText') ?? undefined });
  if (!fields.success) return fail('altTooShort');

  const body = Buffer.from(await file.arrayBuffer());

  try {
    const result = await uploadMedia({
      tenantId: session.tenantId,
      body,
      actor: actorFromSession(session),
      fileName: file.name || undefined,
      declaredContentType: file.type || undefined,
      altText: fields.data.altText,
      request: { headers: request.headers },
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
