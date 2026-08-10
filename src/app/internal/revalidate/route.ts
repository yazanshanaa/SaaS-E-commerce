import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { getEnv } from '@/env';
import { safeEqual } from '@/server/crypto';
import { logger } from '@/server/logger';
import { INTERNAL_SECRET_HEADER } from '@/server/revalidation';
import { revalidateStorefront } from '@/app/site/_data/cache';

/**
 * The worker's door into Next's data cache.
 *
 * `revalidateTag()` only works inside a Next-managed context, and the worker is a separate
 * container. Without this route the image pipeline could finish a variant and have no way to
 * tell the storefront — the contract in `src/app/site/_data/cache.ts` says "call this after any
 * write that changes what the storefront renders", and the queue is where several of those
 * writes finish.
 *
 * Internal to the docker network, exactly like `/internal/domain-ask`: `proxy.ts` passes
 * `/internal/*` through without resolving a tenant, and the Caddyfile never publishes it. The
 * shared secret is the second layer, and it is REQUIRED in production — an unauthenticated cache
 * drop is a cheap way to make every storefront render uncached, so it fails closed rather than
 * quietly running open on a box where someone forgot the variable.
 */
export const dynamic = 'force-dynamic';

const bodySchema = z.object({ tenantId: z.string().min(1) });

function authorise(request: NextRequest): { ok: true } | { ok: false; status: number } {
  const env = getEnv();
  const configured = env.INTERNAL_API_SECRET;

  if (!configured) {
    // Refusing is the only safe direction: a production box with no secret would otherwise
    // accept a cache drop from anything that can reach the container.
    if (env.NODE_ENV === 'production') return { ok: false, status: 503 };
    return { ok: true };
  }

  const presented = request.headers.get(INTERNAL_SECRET_HEADER);
  if (!presented || !safeEqual(presented, configured)) return { ok: false, status: 401 };

  return { ok: true };
}

export async function POST(request: NextRequest): Promise<Response> {
  const auth = authorise(request);
  if (!auth.ok) {
    if (auth.status === 503) {
      logger().error({}, 'INTERNAL_API_SECRET is unset in production — /internal/revalidate refuses');
    }
    return new NextResponse(null, { status: auth.status });
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return new NextResponse(null, { status: 400 });

  await revalidateStorefront(parsed.data.tenantId);

  return NextResponse.json({ ok: true }, { headers: { 'cache-control': 'no-store' } });
}
