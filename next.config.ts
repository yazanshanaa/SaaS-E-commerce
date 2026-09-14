import type { NextConfig } from 'next';

/**
 * Souq Bartaa — Next.js configuration.
 *
 * Nothing here may hardcode the platform domain: every surface reads DOMAIN from env
 * (CLAUDE.md, stack rules). Tenant resolution happens in `proxy.ts`, not here.
 */
const nextConfig: NextConfig = {
  reactStrictMode: true,

  /**
   * `X-Powered-By: Next.js` is Next's default and it was reaching production — verified with a
   * `curl -I` against the live storefront during the 2026-09-07 audit.
   *
   * It is not exploitable on its own, and saying otherwise would be theatre. What it does is hand
   * a scanner the framework for free, so that the next advisory published against this framework
   * arrives with a pre-built target list that already includes this host. The header buys nothing
   * in return: no client reads it, no tool here depends on it.
   *
   * Caddy's `Via: 1.1 Caddy` is the same class of leak and is suppressed in the Caddyfile, which
   * is the only place that header can be removed — it is written by the proxy, not by this process.
   */
  poweredByHeader: false,

  // Packages that must stay outside the bundler (native bindings / heavy server-only deps).
  serverExternalPackages: [
    '@prisma/client',
    'sharp',
    'bullmq',
    'ioredis',
    'pino',
    'archiver',
    '@node-rs/argon2',
  ],

  typescript: {
    // Same reasoning: `pnpm typecheck` is the gate.
    ignoreBuildErrors: false,
  },

  experimental: {
    /**
     * THE PROXY'S BODY BUFFER MUST BE LARGER THAN THE LARGEST UPLOAD WE ACCEPT.
     *
     * Next 16 clones and buffers the request body whenever a proxy runs, so that both `proxy.ts`
     * and the route handler can read it — and `proxyClientMaxBodySize` caps that buffer at **10MB
     * by default**. Over the cap the body is not rejected, it is TRUNCATED, with only a server-side
     * warning (node_modules/next/dist/docs/.../proxyClientMaxBodySize.md).
     *
     * `ABSOLUTE_MAX_UPLOAD_BYTES` in `src/server/media/limits.ts` is 25MB, and the top plan's
     * per-file limit is sized against it. So every upload between 10MB and 25MB — exactly the range
     * a merchant photographing stock on a modern phone produces — reached
     * `/api/media/upload` as a truncated multipart body. What the route then saw was a short file:
     * either a magic-byte check on a partial header, or a JPEG that decodes to a corrupt image, with
     * an Arabic error message blaming the merchant's file. The route's own counting reader was never
     * the bound it was written to be.
     *
     * 26mb rather than 25: the cap covers the whole multipart envelope — boundaries, the `alt` text
     * field and the headers — not just the file part, so a 25MB file needs headroom to arrive whole.
     * The REAL limit stays server-side and per-plan in the route, which is where it belongs; this
     * only stops the framework from quietly eating the request first.
     *
     * Written as a literal because this file cannot import from `src/`
     * (`tests/unit/guardrails.test.ts` scans there and this config sits outside it) — the two are
     * kept in step by `tests/unit/a3-limits-and-alt.test.ts`. 2026-09-07 audit.
     */
    proxyClientMaxBodySize: '26mb',
  },

  /**
   * `next dev` refuses cross-origin requests to `/_next/*` by default (Origin/Referer host not
   * recognised) — a guard against a public DNS name pointing at a developer's loopback address
   * reading their dev server. That is exactly the platform's own dev shape: every surface is a
   * subdomain of DOMAIN resolved to 127.0.0.1, so without this the admin/app/storefront pages
   * load as bare HTML with every script 403'd — React never hydrates and every button is dead.
   * `*.${DOMAIN}` covers admin.*, app.* and every storefront slug in one entry.
   */
  ...(process.env.DOMAIN ? { allowedDevOrigins: [`*.${process.env.DOMAIN}`] } : {}),

  images: {
    // Media is always served through the CDN in front of R2 — never from the app server.
    remotePatterns: process.env.CDN_PUBLIC_BASE_URL
      ? [
          {
            protocol: 'https',
            hostname: new URL(process.env.CDN_PUBLIC_BASE_URL).hostname,
          },
        ]
      : [],
    formats: ['image/avif', 'image/webp'],
  },

  async headers() {
    return [
      {
        /**
         * The constant security headers (Phase 6).
         *
         * They live HERE rather than in `proxy.ts` because the proxy matcher deliberately excludes
         * `_next/static`, `favicon.ico` and every binary extension — so a header set there would
         * miss the self-hosted Arabic fonts and every static asset, which is exactly where
         * `nosniff` earns its keep. The Content-Security-Policy cannot join them: it varies per
         * surface and names runtime origins, so it is assembled per request in the proxy (see
         * `src/server/http/security-headers.ts` for the full reasoning).
         *
         * Strict-Transport-Security is deliberately absent: it belongs at the TLS terminator, and
         * this process is reached over plain HTTP inside the docker network. It is set in the
         * Caddyfile, where `tests/unit/phase6-security-headers.test.ts` asserts it.
         *
         * Kept in sync with `CONSTANT_SECURITY_HEADERS` by that same test — this file sits outside
         * the guardrail's scan roots and cannot import from `src/`.
         */
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          /**
           * X-Frame-Options is deliberately gone (Phase 11, Q37): framing is governed by
           * `frame-ancestors` alone, assembled per request in the proxy — which is the only way
           * the live preview's one-path exception can exist, because `headers()` APPENDS rather
           * than replaces and would have shipped DENY beside SAMEORIGIN. Reasoning on
           * `CONSTANT_SECURITY_HEADERS` in `src/server/http/security-headers.ts`.
           */
          {
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()',
          },
          /**
           * COOP is sent ONLY over https, and the reason is not purity.
           *
           * A browser ignores `Cross-Origin-Opener-Policy` on a non-secure origin — and says so, at
           * error level, in the console, on every page load. The e2e suite asserts that a storefront
           * logs nothing to the console (an honest check that has caught real bugs), so shipping a
           * header the browser is guaranteed to reject would mean either a permanently red gate or a
           * gate loosened to accommodate a header that was doing nothing anyway.
           *
           * `PUBLIC_SCHEME` is read at BUILD time, which is correct here: a deployment does not
           * change scheme between build and run, and `headers()` has no request to consult.
           */
          ...(process.env.PUBLIC_SCHEME === 'https'
            ? [{ key: 'Cross-Origin-Opener-Policy', value: 'same-origin' }]
            : []),
        ],
      },
      {
        // Export artifacts are a whole business in one file — never cached, never indexed.
        source: '/export/:path*',
        headers: [
          { key: 'Cache-Control', value: 'no-store, max-age=0' },
          { key: 'X-Robots-Tag', value: 'noindex, nofollow' },
        ],
      },
    ];
  },
};

export default nextConfig;
