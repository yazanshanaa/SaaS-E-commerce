import { headers } from 'next/headers';
import { PUBLIC_ACTOR, tenantDb } from '@/server/db';
import { logger } from '@/server/logger';
import { settleOrder } from '@/server/orders';
import {
  adapterForValue,
  isGatewayProvider,
  loadCredentials,
  readEnabledGateway,
} from '@/server/payments';
import { readRequestTenant } from '@/server/tenancy';

/**
 * The gateway settlement callback.
 *
 * Built now although NO PROVIDER IS ACTIVATED (the Launch Gate: a real Israeli gateway needs a
 * registered entity). That is deliberate — activation should be a credentials change and a
 * contract test, not a new route with a new set of mistakes to make in it. The mistakes worth
 * freezing now are the ones that are invisible when they are wrong:
 *
 *   - THE RAW BYTES ARE READ ONCE, as text, and the signature is checked over them. Re-serialising
 *     a parsed object changes the whitespace the provider actually signed, so every legitimate
 *     callback would fail — and the tempting fix is to stop checking.
 *   - VERIFY BEFORE PARSE. Nothing from an unverified body reaches a schema, let alone the
 *     database.
 *   - THE TENANT COMES FROM THE HOSTNAME, never from the body. A provider POSTing `tenantId` would
 *     be a cross-tenant write with a signature from a different merchant's key.
 *   - THE CREDENTIALS ARE THE TENANT'S OWN. `loadCredentials` is scoped to the resolved tenant, so
 *     a body signed with shop A's secret cannot settle an order in shop B.
 *   - IDEMPOTENT, AND 200 ON A REPEAT. A provider retries until it gets a 2xx, and the first
 *     response is the one most likely to be lost. `settleOrder` claims the transition with a
 *     conditional update, so a second notice is a no-op — and answering 4xx to it would make the
 *     provider retry forever over an order that is already paid.
 *
 * A `scaffolded` provider answers 404. There is nothing on the other end to have sent this, and an
 * endpoint that accepted an unsigned body for one would be an open "mark this order paid" route.
 */
export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ provider: string }> },
): Promise<Response> {
  const requestHeaders = await headers();
  const tenant = readRequestTenant(requestHeaders);

  if (tenant.surface !== 'storefront' || !tenant.tenantId || tenant.isDemo) {
    return Response.json({ ok: false }, { status: 404 });
  }

  const { provider } = await params;
  if (!isGatewayProvider(provider)) return Response.json({ ok: false }, { status: 404 });

  const adapter = adapterForValue(provider);
  if (adapter.status !== 'active') return Response.json({ ok: false }, { status: 404 });

  const db = tenantDb(tenant.tenantId, PUBLIC_ACTOR);

  // The provider must be the one this tenant actually has switched on — a callback for a provider
  // they configured and then disabled settles nothing.
  const enabled = await readEnabledGateway(db, tenant.tenantId);
  if (enabled?.provider !== provider) return Response.json({ ok: false }, { status: 404 });

  const credentials = await loadCredentials(db, tenant.tenantId, provider);
  if (!credentials) return Response.json({ ok: false }, { status: 404 });

  // Once, as text. See the note above about re-serialising.
  const body = await request.text();
  const verified = await adapter.verifyCallback({ body, headers: request.headers }, credentials);

  if (!verified.ok) {
    // The REASON is logged, never the body: a settlement notice is a third party's payload and may
    // carry anything. `rawPayload` is on the logger's redaction list for the same reason.
    logger().warn(
      { tenantId: tenant.tenantId, provider, reason: verified.reason },
      'gateway callback refused',
    );
    return Response.json({ ok: false }, { status: verified.reason === 'bad_signature' ? 401 : 400 });
  }

  const applied = await settleOrder({
    tenantId: tenant.tenantId,
    orderId: verified.orderId,
    provider,
    providerRef: verified.providerRef,
    paidAgorot: verified.paidAgorot,
    status: verified.status,
    rawPayload: safeJson(body),
  });

  // 200 whether or not it changed anything: a repeat of a notice we already applied is a success
  // from the provider's point of view, and telling them otherwise buys an infinite retry loop.
  return Response.json({ ok: true, applied: applied.applied }, { status: 200 });
}

/**
 * Store the notice as JSON when it is JSON, and as a string when it is not.
 *
 * Kept verbatim for reconciliation — this is the evidence of what the provider actually said when
 * a merchant disputes an amount. It never reaches a log line or an event payload.
 */
function safeJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return { raw: body.slice(0, 4_000) };
  }
}
