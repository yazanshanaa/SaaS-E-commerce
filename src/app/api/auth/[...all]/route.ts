import { toNextJsHandler } from 'better-auth/next-js';
import { getEnv } from '@/env';
import { auth } from '@/server/auth';
import { clearFailedSignIns, isLockedOut, recordFailedSignIn } from '@/server/auth/lockout';
import { hashIp } from '@/server/crypto';
import { getClientIp } from '@/server/http/get-client-ip';
import { consumeSlot } from '@/server/rate-limit';
import { t } from '@/shared/i18n';

/**
 * better-auth's route handler, with the account lockout wrapped around it (Phase 6).
 *
 * There is no sign-up endpoint to protect: `emailAndPassword.disableSignUp` is true and the
 * organization plugin's `allowUserToCreateOrganization` is false (Q1). The handler still serves
 * sign-in, sign-out, verification, password reset and 2FA — which is why proxy.ts allow-lists
 * `/api/auth/` on app.*.
 *
 * WHY THE LOCKOUT LIVES HERE rather than in `createAuth()`. Both admin and merchant sign-in forms
 * post to this endpoint directly from the browser, so there is no server action to guard, and
 * better-auth's `verify` callback is handed a hash and a password with no identifier attached —
 * it cannot count failures per account because it does not know which account it is checking.
 * This handler is the one place that sees the email, the outcome and the response status together.
 *
 * `request.clone()` before reading the body: the original stream still has to reach better-auth,
 * and a consumed body is an empty sign-in.
 */
export const dynamic = 'force-dynamic';

const handlers = toNextJsHandler(auth().handler);

export const GET = handlers.GET;

/** Only the credential endpoint is wrapped; everything else is passed straight through. */
const SIGN_IN_PATH = '/sign-in/email';

export async function POST(request: Request): Promise<Response> {
  if (!new URL(request.url).pathname.endsWith(SIGN_IN_PATH)) {
    return handlers.POST(request);
  }

  /**
   * THE PER-CLIENT THROTTLE IS OURS, not better-auth's, and that is not duplication.
   *
   * better-auth resolves its own limiter's key from `ipAddressHeaders`, and the best header
   * available to it is `x-real-ip` — which Caddy sets to the PEER. Behind Cloudflare the peer is a
   * Cloudflare edge address, so the library's per-client bucket is really per-edge-node: shared by
   * every visitor routed through it. `getClientIp()` is the only thing on this platform that
   * unwraps `CF-Connecting-IP`, and it does so only after verifying the peer is inside Cloudflare's
   * pinned ranges (invariant 9). So the bound that is actually per-client is applied here.
   *
   * Both layers stay: better-auth's covers the endpoints this wrapper does not touch.
   */
  const { ip } = getClientIp({
    headers: request.headers,
    socketIp: request.headers.get('x-real-ip'),
  });

  const perClient = await consumeSlot({
    key: `auth:sign-in:${hashIp(ip ?? 'unknown')}`,
    limit: getEnv().RATE_LIMIT_LOGIN_PER_15MIN,
    windowSeconds: 900,
  });

  if (!perClient.allowed) return refuse();

  const identifier = await readEmail(request);

  if (identifier && (await isLockedOut(identifier))) {
    /**
     * 429 and the generic Arabic rate-limit copy, deliberately NOT "this account is locked".
     *
     * A distinct message would turn the lockout into an account-existence oracle: an attacker
     * could enumerate merchants by watching which addresses can be locked. The person actually
     * locked out is told the same thing they would be told by the window limiter, and it is
     * true — they have made too many attempts and should wait.
     */
    return refuse();
  }

  const response = await handlers.POST(request);

  if (identifier) {
    /**
     * 401 and 403 are a refused credential; 400 is a malformed request and 5xx is our problem,
     * and counting either of those would let a broken client lock a merchant out of their own
     * shop. `ok` covers the 2xx range including the 2FA challenge, which is a successful
     * first factor.
     */
    if (response.ok) await clearFailedSignIns(identifier);
    else if (response.status === 401 || response.status === 403) {
      await recordFailedSignIn(identifier);
    }
  }

  return response;
}

/**
 * 429 with the generic Arabic copy, and deliberately NOT "this account is locked".
 *
 * A distinct message would turn the lockout into an account-existence oracle: an attacker could
 * enumerate merchants by watching which addresses can be locked. The person actually throttled is
 * told the same thing the window limiter tells them, and it is true — too many attempts, wait.
 */
function refuse(): Response {
  return Response.json(
    { message: t('common', 'errors.rateLimited.body') },
    { status: 429, headers: { 'cache-control': 'no-store', 'retry-after': '900' } },
  );
}

/**
 * The identifier, from EITHER body encoding better-auth accepts.
 *
 * `/sign-in/email` declares `allowedMediaTypes: ['application/x-www-form-urlencoded',
 * 'application/json']`. Reading only JSON meant a form-encoded post produced no identifier — so it
 * was neither counted nor checked, and the entire account lockout could be walked past by changing
 * one header. The sign-in forms on this platform send JSON, which is exactly why the hole would
 * never have surfaced in normal use.
 *
 * Never throws: a body in neither shape simply means there is nothing to key on, and the per-client
 * throttle above still applies.
 */
async function readEmail(request: Request): Promise<string | null> {
  const type = (request.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();

  try {
    if (type === 'application/x-www-form-urlencoded') {
      const form = new URLSearchParams(await request.clone().text());
      return sanitise(form.get('email'));
    }

    const body: unknown = await request.clone().json();
    if (body && typeof body === 'object' && 'email' in body) {
      return sanitise((body as { email?: unknown }).email);
    }
  } catch {
    // Malformed, or already consumed upstream. Either way there is nothing to key on.
  }

  return null;
}

function sanitise(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const email = value.trim();
  return email.length > 0 && email.length <= 320 ? email : null;
}
