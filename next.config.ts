import type { NextConfig } from 'next';

/**
 * Souq Bartaa — Next.js configuration.
 *
 * Nothing here may hardcode the platform domain: every surface reads DOMAIN from env
 * (CLAUDE.md, stack rules). Tenant resolution happens in `proxy.ts`, not here.
 */
const nextConfig: NextConfig = {
  reactStrictMode: true,

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
          { key: 'X-Frame-Options', value: 'DENY' },
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
