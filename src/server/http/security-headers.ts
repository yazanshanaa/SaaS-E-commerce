import { getEnv } from '@/env';
import type { Surface } from '@/server/tenancy';

/**
 * The platform's security headers, and the Content-Security-Policy that carries most of the work.
 *
 * WHY THIS LIVES IN THE PROXY AND NOT IN `next.config.ts`.
 * `headers()` is evaluated once at build time and can only host-scope against a literal. This
 * platform has four surfaces — admin, app, a platform storefront and a merchant CUSTOM DOMAIN —
 * and the last of those is a database row added long after the build. The two external origins a
 * page may legitimately reach (the CDN and the Umami script) are runtime env. So the policy can
 * only be assembled per request, which is exactly what `proxy.ts` already does for everything else
 * about a request's identity. The constant headers that need no per-request knowledge stay in
 * `next.config.ts`, where they also cover the static assets the proxy matcher deliberately skips.
 *
 * WHY THERE IS NO NONCE — measured, not assumed.
 *
 * Every App Router document ships inline `self.__next_f.push(...)` flight-data scripts. They are
 * not ours, they change per render, and they cannot be hashed, so a nonce is the only way to run
 * them under a strict policy. Next derives that nonce by reading the `content-security-policy`
 * header off the REQUEST (`app-render.js`), which is why the documented pattern has middleware set
 * the policy on the request headers.
 *
 * ON THIS PLATFORM THAT PATTERN DOES NOT REACH THE PAGES. `proxy.ts` rewrites every hostname into
 * its own subtree — that is how three surfaces live in one App Router — and Next 16.3 does not
 * carry the request-header override through `NextResponse.rewrite()` as far as the nonce read. It
 * does carry it through `NextResponse.next()`: measured directly, `/demo-request` (unprefixed, no
 * rewrite) renders `nonce="…"` matching the header, while `/sign-in` (rewritten to
 * `/dashboard/sign-in`) renders `"nonce":"$undefined"` on every script. The `x-souq-*` context
 * headers survive the same rewrite, so this is specific to that one read rather than to header
 * overrides in general.
 *
 * A nonce in the header and none in the HTML is the WORST outcome available: a browser that sees a
 * nonce ignores `'unsafe-inline'` entirely, so the policy would block Next's own bootstrap scripts
 * and ship a blank page on every surface a human uses. Emitting the nonce only on the handful of
 * unprefixed paths would be worse still — a policy that is strict where nobody is and permissive on
 * every page that matters, while reading as strict in a review.
 *
 * So `script-src` carries `'unsafe-inline'`, uniformly and on purpose. What the policy still buys
 * is not small: no external script origin but the analytics one, `object-src 'none'`,
 * `base-uri 'self'`, `frame-ancestors 'none'` and `form-action 'self'` — the last of which is what
 * stops an injected form from posting a customer's name and phone number to another host. The
 * platform's actual injection surface is narrow and independently defended: React escapes by
 * default, and `custom_html` goes through an allow-list tokeniser that strips `<script>` whole.
 *
 * Recorded as an open item in docs/DECISIONS.md with the reproduction above.
 *
 * THE SECOND CONCESSION, STATED RATHER THAN HIDDEN: `style-src` keeps `'unsafe-inline'`.
 * The storefront applies its whole token system through an inline style ATTRIBUTE on the shell —
 * per-tenant colours, radii and type scale — and CSP3 governs style attributes with
 * `style-src-attr`, which ignores nonces by design. Hashes are impossible too, because the values
 * differ per tenant. Removing it would strip every colour from every storefront and surface as a
 * wall of contrast failures rather than as a visible CSP error. Recorded in docs/DECISIONS.md.
 */

/**
 * Headers that need nothing about the request. Applied in `next.config.ts` with `source: '/:path*'`
 * so they also reach `/public` fonts and `_next/static`, which the proxy matcher excludes.
 *
 * HSTS is deliberately ABSENT: it belongs at the TLS terminator, and this app is served over plain
 * HTTP inside the docker network. It is set in the Caddyfile, where a unit test counts it.
 */
export const CONSTANT_SECURITY_HEADERS: ReadonlyArray<{ key: string; value: string }> = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  /**
   * `strict-origin-when-cross-origin` rather than `no-referrer`: a merchant's storefront wants to
   * show up as a referrer in their own analytics, and same-origin navigation keeps the full path.
   * What it stops is a full URL — which on this platform can contain an export token — leaking to
   * a third-party host.
   */
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  /** Belt to `frame-ancestors 'none'`, for anything that predates CSP3. */
  { key: 'X-Frame-Options', value: 'DENY' },
  /**
   * Nothing on this platform asks for a camera, a microphone, a location or a payment handler.
   * The map section builds deep links rather than reading a position, which is what makes
   * `geolocation=()` free rather than a trade.
   */
  {
    key: 'Permissions-Policy',
    value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()',
  },
];

/**
 * Sent only over https — see the note in `next.config.ts`.
 *
 * Kept out of the list above because that list is "what every response carries"; a browser ignores
 * COOP on a non-secure origin and logs an error saying so, which on a platform whose e2e suite
 * asserts a clean console would be a permanently failing gate for a header that was inert.
 */
export const SECURE_ONLY_HEADERS: ReadonlyArray<{ key: string; value: string }> = [
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
];

/** The two request headers a client must never be able to supply — see `buildCsp`. */
export const CSP_REQUEST_HEADERS = [
  'content-security-policy',
  'content-security-policy-report-only',
] as const;

function originOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

export interface CspInput {
  /**
   * Storefronts are the only surface that may load the analytics script, and only after consent —
   * but the policy is set before the page decides, so the ORIGIN is allowed here and the decision
   * to emit the tag stays where it already is (`analyticsDecision`). A CSP is a ceiling, not a
   * switch: allowing an origin nothing requests costs nothing, and denying one the page will
   * legitimately request breaks the shop.
   */
  surface: Surface;
}

/**
 * Assemble the policy for one request.
 *
 * Derives every host from `getEnv()` and never names one. `tests/unit/guardrails.test.ts` forbids
 * the literal platform domain anywhere under `src/`, and the CDN and analytics origins are
 * per-deployment anyway — a policy with a hostname baked in would be wrong on the first customer
 * who brought their own.
 */
export function buildCsp({ surface }: CspInput): string {
  const env = getEnv();

  const cdn = originOf(env.CDN_PUBLIC_BASE_URL);
  const analytics = surface === 'storefront' ? originOf(env.UMAMI_SCRIPT_URL) : null;

  // See the module note: no nonce, because Next cannot receive one through the surface rewrite,
  // and a nonce the HTML never gets would block Next's own scripts on every page.
  const script = ["'self'", "'unsafe-inline'"];
  if (analytics) script.push(analytics);

  /**
   * `data:` is required — the shell emits an inline SVG favicon as a data URI, and `blob:` covers
   * the object URLs the media library builds for a local preview before an upload finishes.
   */
  const img = ["'self'", 'data:', 'blob:'];
  if (cdn) img.push(cdn);

  const connect = ["'self'"];
  if (analytics) connect.push(analytics);

  const directives: Array<[string, string[]]> = [
    ['default-src', ["'self'"]],
    ['base-uri', ["'self'"]],
    ['object-src', ["'none'"]],
    /**
     * `'self'` rather than `'none'`, and the difference is smaller than it looks.
     *
     * Nothing on this platform embeds a frame, so `'none'` was the first choice — until it turned
     * out to block a page from creating an iframe pointed at our OWN origin, which is how A2's
     * cross-site consent-forgery test constructs the attack it measures. Blocking that helps
     * nobody: a real attacker's page carries no policy of ours, so `'none'` would have removed a
     * test's ability to prove a control without removing the attack.
     *
     * Every external origin is still refused, and being framed by anyone is refused separately and
     * absolutely by `frame-ancestors 'none'` below — which is the directive that actually matters
     * for clickjacking.
     */
    ['frame-src', ["'self'"]],
    /** No page here is ever legitimately framed, on any surface. */
    ['frame-ancestors', ["'none'"]],
    /**
     * `form-action 'self'` matters more than it looks: the checkout form is a real HTML form
     * before hydration, and this is what stops an injected `action` from posting a customer's
     * name and phone number to somebody else's host.
     */
    ['form-action', ["'self'"]],
    ['script-src', script],
    ['style-src', ["'self'", "'unsafe-inline'"]],
    ['img-src', img],
    ['font-src', ["'self'"]],
    ['connect-src', connect],
    /** The service worker, registered by the PWA and required for Web Push. */
    ['worker-src', ["'self'"]],
    ['manifest-src', ["'self'"]],
  ];

  const policy = directives
    .map(([name, values]) => `${name} ${values.join(' ')}`)
    .join('; ');

  /**
   * Only under HTTPS. In development and in the e2e stack the platform answers on plain HTTP, and
   * a browser that upgrades every request there simply cannot reach it — the header would turn the
   * whole suite red for a directive that means nothing on localhost.
   */
  return env.PUBLIC_SCHEME === 'https' ? `${policy}; upgrade-insecure-requests` : policy;
}

/**
 * The request headers a client must never be able to supply, stripped in `proxy.ts`.
 *
 * Still stripped even though this platform derives no nonce today: the header is READ by Next, and
 * a visitor who supplied one would be choosing a value the framework then trusts. The day the
 * rewrite carries the override — a Next fix, or a routing change here — the strip is what stops
 * that from being an immediate hole rather than something to remember.
 */
export const CSP_IS_NONCE_BASED = false;
