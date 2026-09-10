import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetEnvCache } from '@/env';
import { TENANT_HEADER_NAMES } from '@/server/tenancy';
import {
  CONSTANT_SECURITY_HEADERS,
  CSP_IS_NONCE_BASED,
  CSP_REQUEST_HEADERS,
  SECURE_ONLY_HEADERS,
  buildCsp,
} from '@/server/http/security-headers';

/**
 * The Content-Security-Policy and its siblings.
 *
 * Two halves, tested differently on purpose:
 *   - the POLICY is a pure function, so its directives are asserted directly;
 *   - the PLUMBING is asserted by reading the source. That is unusual and it is the right tool
 *     here: the failure this phase is guarding against is "somebody added an eighth `return` to
 *     `proxy.ts` and did not wrap it", which no amount of exercising the existing seven can catch.
 *     `withRobotsTag` is the cautionary tale — it was called at two of seven exits for two phases.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function source(file: string): string {
  return readFileSync(path.join(repoRoot, file), 'utf8');
}

beforeEach(() => {
  resetEnvCache();
});

describe('the policy itself', () => {
  it('refuses everything by default and allows only what the app actually loads', () => {
    const csp = buildCsp({ surface: 'app' });

    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("base-uri 'self'");
    // The checkout form is a real HTML form before hydration; this is what stops an injected
    // action from posting a customer's name and phone number to somebody else's host.
    expect(csp).toContain("form-action 'self'");
  });

  /**
   * The concession this platform actually makes, pinned so it stays a decision.
   *
   * Next derives its script nonce from the `content-security-policy` REQUEST header, and Next 16.3
   * does not carry that override through `NextResponse.rewrite()` — which is how every surface here
   * is routed. Measured: `/demo-request` (unprefixed) renders a matching `nonce="…"`, `/sign-in`
   * (rewritten) renders `"nonce":"$undefined"`. A nonce in the header with none in the HTML makes a
   * browser ignore `'unsafe-inline'` and block Next's own bootstrap scripts — a blank product.
   *
   * `'unsafe-eval'` is a separate question and stays refused: nothing here evaluates strings.
   */
  it('allows inline scripts — deliberately, and never eval', () => {
    const csp = buildCsp({ surface: 'storefront' });
    const scriptSrc = csp.split('; ').find((part) => part.startsWith('script-src'))!;

    expect(CSP_IS_NONCE_BASED, 'flip this the day the rewrite carries the header').toBe(false);
    expect(scriptSrc).toContain("'unsafe-inline'");
    expect(scriptSrc).not.toContain('nonce-');
    expect(scriptSrc).not.toContain('unsafe-eval');
  });

  /**
   * The concession, asserted so it stays a decision rather than a drift. The storefront applies
   * its whole token set through an inline style ATTRIBUTE on the shell — per-tenant colours, so
   * no hash is possible — and CSP3's `style-src-attr` ignores nonces by design.
   */
  it('keeps unsafe-inline for STYLES, deliberately and only for styles', () => {
    const csp = buildCsp({ surface: 'storefront' });
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
  });

  it('allows the analytics origin on a storefront and nowhere else', () => {
    vi.stubEnv('UMAMI_SCRIPT_URL', 'https://stats.example.test/script.js');
    resetEnvCache();

    expect(buildCsp({ surface: 'storefront' })).toContain('https://stats.example.test');
    expect(buildCsp({ surface: 'app' })).not.toContain('stats.example.test');
    expect(buildCsp({ surface: 'admin' })).not.toContain('stats.example.test');

    vi.unstubAllEnvs();
    resetEnvCache();
  });

  it('allows the CDN for images only, and always allows data: for the inline favicon', () => {
    vi.stubEnv('CDN_PUBLIC_BASE_URL', 'https://cdn.example.test/media');
    resetEnvCache();

    const csp = buildCsp({ surface: 'storefront' });
    const img = csp.split('; ').find((part) => part.startsWith('img-src'))!;
    const script = csp.split('; ').find((part) => part.startsWith('script-src'))!;

    expect(img).toContain('https://cdn.example.test');
    expect(img).toContain('data:');
    expect(script).not.toContain('cdn.example.test');

    vi.unstubAllEnvs();
    resetEnvCache();
  });

  it('allows the service worker and the manifest the PWA needs', () => {
    const csp = buildCsp({ surface: 'storefront' });
    expect(csp).toContain("worker-src 'self'");
    expect(csp).toContain("manifest-src 'self'");
  });

  it('upgrades insecure requests only under https, so the http e2e stack stays reachable', () => {
    expect(buildCsp({ surface: 'app' })).not.toContain('upgrade-insecure-requests');

    vi.stubEnv('PUBLIC_SCHEME', 'https');
    resetEnvCache();
    expect(buildCsp({ surface: 'app' })).toContain('upgrade-insecure-requests');

    vi.unstubAllEnvs();
    resetEnvCache();
  });

  it('keeps the directives that still do real work without a nonce', () => {
    const csp = buildCsp({ surface: 'storefront' });

    // What survives the concession above, and why the policy is still worth shipping.
    for (const directive of [
      "object-src 'none'",
      "base-uri 'self'",
      "frame-ancestors 'none'",
      "form-action 'self'",
      "font-src 'self'",
    ]) {
      expect(csp).toContain(directive);
    }
  });

  /**
   * Q37 (Phase 11, owner decision 2026-08-28): framing is governed by `frame-ancestors` ALONE.
   *
   * Three properties, each of which failing is a different regression:
   *   1. the default stays `'none'` on every surface — the exception must be asked for;
   *   2. `framable` relaxes to `'self'` and never to a host list — same-origin only;
   *   3. the proxy asks for it on EXACTLY ONE path shape, the preview segment. Source-asserted,
   *      because the failure this guards against is a second caller quietly widening the hole.
   */
  it('relaxes frame-ancestors to self ONLY when asked, and only the preview asks', () => {
    expect(buildCsp({ surface: 'app' })).toContain("frame-ancestors 'none'");
    expect(buildCsp({ surface: 'app', framable: false })).toContain("frame-ancestors 'none'");
    expect(buildCsp({ surface: 'app', framable: true })).toContain("frame-ancestors 'self'");
    expect(buildCsp({ surface: 'app', framable: true })).not.toContain("frame-ancestors 'none'");
    // The other two surfaces can express it too — the PLUMBING below is what keeps them from
    // ever asking. A capability that exists only for one caller is asserted at the caller.
    const proxy = source('src/proxy.ts').replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, '');

    // Exactly one buildCsp call site, and it passes the framable flag.
    const calls = proxy.match(/buildCsp\(\{[^}]*\}\)/g) ?? [];
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('framable');

    // The flag is computed from the preview segment on the app surface (plus its single-tenant
    // spelling), and from nothing else. One helper, two guarded uses, no third.
    expect(proxy).toContain("pathname === '/preview' || pathname.startsWith('/preview/')");
    const uses = proxy.match(/isPreviewSegment\(/g) ?? [];
    expect(uses.length, 'isPreviewSegment: one definition, two guarded calls').toBe(3);
    expect(proxy).toContain("parsed.surface === 'app' && isPreviewSegment(pathname)");
  });

  /**
   * The header this decision REMOVED, pinned absent in both homes. If it comes back in one and
   * not the other, the sync test above goes green while the posture silently forks — which is
   * exactly how the Phase 4 `/internal/*` hole happened one layer down.
   */
  it('ships no X-Frame-Options anywhere — frame-ancestors carries framing alone (Q37)', () => {
    expect(CONSTANT_SECURITY_HEADERS.map((h) => h.key)).not.toContain('X-Frame-Options');
    const config = source('next.config.ts').replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, '');
    expect(config).not.toContain('X-Frame-Options');
  });
});

describe('the plumbing in proxy.ts', () => {
  const proxy = () => source('src/proxy.ts');

  it('wraps EVERY return in secure(), so no surface ships bare', () => {
    const text = proxy();
    const body = text.slice(text.indexOf('export default async function proxy'));

    const returns = body.match(/^\s*return\s.*/gm) ?? [];

    /**
     * A return is compliant if it calls `secure(...)` inline, or returns `secured` — the one
     * intermediate, which exists because the demo branch has to set a cookie on the response
     * after wrapping it. Anything else is a surface shipping without a policy.
     */
    const offenders = returns.filter(
      (line) => !/return secure\(/.test(line) && !/return secured;/.test(line),
    );

    expect(returns.length).toBeGreaterThan(4);
    expect(
      offenders,
      'a return in proxy() that does not go through secure() ships a surface with no CSP',
    ).toEqual([]);
  });

  it('strips a client-supplied CSP header before Next can read a nonce out of it', () => {
    expect(CSP_REQUEST_HEADERS).toContain('content-security-policy');
    expect(CSP_REQUEST_HEADERS).toContain('content-security-policy-report-only');
    // Inside sanitisedHeaders, which runs before the /internal/* early return.
    expect(proxy()).toContain('for (const name of CSP_REQUEST_HEADERS)');
  });

  it('gives the demo gate its noindex header, which it never had', () => {
    const text = proxy();
    const gate = text.slice(text.indexOf("url.pathname = '/demo-gate'"));
    expect(gate.slice(0, 600)).toContain('withRobotsTag');
  });
});

describe('the headers that cover what the proxy matcher cannot', () => {
  it('declares the constant set in next.config.ts with the same values', () => {
    const config = source('next.config.ts');

    for (const header of CONSTANT_SECURITY_HEADERS) {
      expect(config, `${header.key} missing from next.config.ts`).toContain(header.key);
      expect(config, `${header.key} value drifted`).toContain(header.value);
    }

    // `/:path*` rather than a route prefix: fonts and _next/static never reach the proxy.
    expect(config).toContain("source: '/:path*'");
  });

  it('sends COOP only over https, because a browser rejects it anywhere else — loudly', () => {
    const config = source('next.config.ts');

    for (const header of SECURE_ONLY_HEADERS) {
      expect(config).toContain(header.key);
    }
    // The guard itself, not just the header: without it the e2e console check goes permanently red.
    expect(config).toContain("process.env.PUBLIC_SCHEME === 'https'");
  });

  it('does not try to set HSTS from the app, which never terminates TLS', () => {
    // Comments stripped: the config EXPLAINS why HSTS is absent, and the explanation names it.
    const config = source('next.config.ts').replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, '');
    expect(config).not.toContain('Strict-Transport-Security');
    expect(CONSTANT_SECURITY_HEADERS.map((h) => h.key)).not.toContain('Strict-Transport-Security');
  });

  /**
   * Caddy matches ONE site block per request, so a header written in the platform block does not
   * reach a merchant's custom domain. Phase 4 learned this the hard way with `/internal/*`; the
   * count is asserted rather than the presence.
   */
  it('sets HSTS in BOTH Caddy site blocks, with no preload flag', () => {
    const caddy = source('Caddyfile')
      .split('\n')
      .filter((line) => !line.trim().startsWith('#'))
      .join('\n');

    const directives = caddy.match(/header Strict-Transport-Security/g) ?? [];
    expect(directives.length).toBe(2);
    expect(caddy).not.toContain('preload');
  });

  /**
   * `includeSubDomains` on the PLATFORM block only.
   *
   * On hostnames we operate it is free. On a MERCHANT'S OWN domain it asserts HSTS across
   * subdomains we have never seen and do not control — an office tool or a legacy host of theirs
   * on plain HTTP would become unreachable for two years because they pointed one CNAME at us.
   * That is not a promise this platform is entitled to make on somebody else's behalf, and it is
   * not one they could undo without waiting out our max-age.
   */
  it('scopes includeSubDomains to the platform block, never to a merchant domain', () => {
    const values = [
      ...source('Caddyfile').matchAll(/header Strict-Transport-Security "([^"]+)"/g),
    ].map((match) => match[1]!);

    expect(values).toHaveLength(2);
    expect(values.filter((value) => value.includes('includeSubDomains'))).toHaveLength(1);
    // Both still assert HSTS itself, and for the same long window.
    for (const value of values) expect(value).toContain('max-age=63072000');
  });

  /**
   * The fingerprinting pair, closed together (2026-09-07 audit).
   *
   * `X-Powered-By: Next.js` and `Via: 1.1 Caddy` were both observed on the LIVE storefront. Neither
   * is exploitable alone, which is exactly why they survived three security reviews — and why they
   * are asserted here rather than left to the next person's judgement. The cost of the pair is that
   * the next advisory against either component arrives with this host already on a target list.
   */
  it('announces neither the framework nor the proxy', () => {
    const config = source('next.config.ts').replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, '');
    expect(config).toContain('poweredByHeader: false');

    // Caddy adds `Via` in `reverse_proxy`, so — like HSTS — it has to be removed in BOTH site
    // blocks. One `header -Via` would leave every merchant custom domain still announcing it.
    const caddy = source('Caddyfile')
      .split('\n')
      .filter((line) => !line.trim().startsWith('#'))
      .join('\n');
    expect((caddy.match(/header -Via/g) ?? []).length).toBe(2);
  });
});

/**
 * COOKIE SECURE FLAGS — asserted from source, as a CLASS rather than one cookie at a time.
 *
 * The defect this pins (2026-09-07 audit): the storefront consent cookie derived `secure` from
 * `new URL(request.url).protocol === 'https:'`. Caddy terminates TLS and proxies to `web:3000`
 * over PLAIN HTTP, so on the production deployment — the only one where the flag matters — that
 * expression evaluated to `false`. The demo-token cookie, a bearer credential to a private
 * showcase, carried no `secure` option at all.
 *
 * Both now read `PUBLIC_SCHEME`, which is the platform's single answer to "are we on HTTPS" and
 * the one better-auth already keys `useSecureCookies` off. Asserting the ABSENCE of the
 * request-derived idiom is what stops the next cookie from reintroducing it: a test that only
 * checked the two known call sites would pass on a third written the old way.
 */
/**
 * THE PERIMETER STRIP (2026-09-07 audit).
 *
 * `sanitisedHeaders()` in proxy.ts removes client-supplied tenant context — but the proxy MATCHER
 * excludes `_next/static`, `favicon.ico` and every URL ending in an image or font extension, so for
 * those paths nothing stripped anything and `readRequestTenant()` would have read whatever the
 * caller sent. No route consumes the context on such a path today, which is a fact about today's
 * route table rather than a control. Caddy now removes them at the edge, where the matcher cannot
 * reach.
 *
 * Two lists that must not drift: `TENANT_HEADER_NAMES` in src/server/tenancy and the `header_up -`
 * lines in the Caddyfile. This is the test that keeps them equal — including in BOTH site blocks,
 * because Caddy matches exactly one per request and a merchant custom domain is served by the other.
 */
describe('the Caddy perimeter', () => {
  const caddy = source('Caddyfile')
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n');

  it('strips every tenant context header the app would otherwise trust', () => {
    const stripped = [...caddy.matchAll(/header_up -(X-Souq-[\w-]+)/gi)].map((m) =>
      m[1]!.toLowerCase(),
    );

    for (const name of TENANT_HEADER_NAMES) {
      // Twice: once per site block. A header stripped only on platform hostnames still arrives
      // forged on a merchant's own domain, which is the surface with the least oversight.
      expect(
        stripped.filter((candidate) => candidate === name).length,
        `${name} must be stripped in BOTH Caddy site blocks`,
      ).toBe(2);
    }
  });

  it('strips the CSP request headers Next reads a nonce from', () => {
    for (const name of CSP_REQUEST_HEADERS) {
      const pattern = new RegExp(`header_up -${name}(?![\\w-])`, 'gi');
      expect((caddy.match(pattern) ?? []).length, `${name} in both blocks`).toBe(2);
    }
  });
});

describe('cookies', () => {
  const COOKIE_SOURCES = [
    'src/proxy.ts',
    'src/app/api/storefront/consent/route.ts',
    'src/server/auth/config.ts',
  ];

  it('never derives the secure flag from the request URL, which is plain http behind Caddy', () => {
    for (const file of COOKIE_SOURCES) {
      const code = source(file).replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, '');
      expect(code, `${file} must not read the scheme off the request`).not.toMatch(
        /new URL\([^)]*\.url\)\.protocol/,
      );
    }
  });

  it('sets secure from PUBLIC_SCHEME everywhere a cookie is written', () => {
    for (const file of ['src/proxy.ts', 'src/app/api/storefront/consent/route.ts']) {
      const code = source(file).replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, '');
      // Every `cookies.set(` / `store.set(` in these files carries the flag, from the one source.
      expect(code, `${file} sets a cookie without the deployment's scheme`).toContain(
        "secure: getEnv().PUBLIC_SCHEME === 'https'",
      );
    }

    // better-auth is configured rather than called per cookie, so it states the same rule once.
    const auth = source('src/server/auth/config.ts').replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, '');
    expect(auth).toContain("useSecureCookies: env.PUBLIC_SCHEME === 'https'");
  });

  it('keeps every cookie httpOnly — none of them is read by client JavaScript', () => {
    for (const file of ['src/proxy.ts', 'src/app/api/storefront/consent/route.ts']) {
      const code = source(file).replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, '');
      const sets = (code.match(/\.set\(\s*[A-Z_]+_COOKIE/g) ?? []).length;
      expect(sets).toBeGreaterThan(0);
      expect((code.match(/httpOnly: true/g) ?? []).length).toBe(sets);
    }
  });
});
