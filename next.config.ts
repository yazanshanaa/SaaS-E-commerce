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
