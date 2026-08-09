import { createHmac, timingSafeEqual } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { storage, isMediaKey, isExportKey } from '@/server/storage';
import { getEnv } from '@/env';

/**
 * DEVELOPMENT ONLY: serves objects from the local-disk storage driver so `pnpm dev` works with
 * no cloud credentials and no network. `env.ts` refuses STORAGE_DRIVER=local in production, and
 * this route refuses to run there too.
 *
 * It reproduces the two production access rules so code written against it behaves the same on
 * R2 behind the CDN:
 *   - media keys are public,
 *   - EXPORT keys require a valid signature and are never served unsigned. An export artifact
 *     is a whole business in one file; the media prefix is public and it must never be.
 */
export const dynamic = 'force-dynamic';

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ key: string[] }> },
): Promise<Response> {
  const env = getEnv();
  if (env.STORAGE_DRIVER !== 'local') {
    return new NextResponse('Not found', { status: 404 });
  }

  const { key: segments } = await context.params;
  const key = segments.join('/');

  if (isExportKey(key)) {
    const expires = Number(request.nextUrl.searchParams.get('expires') ?? 0);
    const signature = request.nextUrl.searchParams.get('signature') ?? '';

    if (!expires || expires * 1000 < Date.now()) {
      return new NextResponse('Expired', { status: 403 });
    }

    const expected = createHmac('sha256', env.ENCRYPTION_KEY)
      .update(`${key}:${expires}`)
      .digest('base64url');

    const a = Buffer.from(signature);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      return new NextResponse('Forbidden', { status: 403 });
    }
  } else if (!isMediaKey(key)) {
    return new NextResponse('Not found', { status: 404 });
  }

  try {
    const body = await storage().get(key);
    return new NextResponse(new Uint8Array(body), {
      headers: {
        'content-type': isExportKey(key) ? 'application/zip' : 'application/octet-stream',
        'cache-control': isExportKey(key) ? 'no-store' : 'public, max-age=31536000, immutable',
        'x-robots-tag': 'noindex',
      },
    });
  } catch {
    return new NextResponse('Not found', { status: 404 });
  }
}
