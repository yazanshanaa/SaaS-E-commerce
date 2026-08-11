import { describe, expect, it } from 'vitest';
import { platformOrigins } from '@/server/auth/config';
import { platformHost } from '@/env';

/**
 * The trusted-origin list, guarded — because the way it failed was invisible.
 *
 * better-auth matches a non-wildcard trusted origin with `pattern === new URL(request).origin`.
 * An origin never carries a trailing slash, so `absoluteUrl(host)` (which returns
 * `https://admin.{DOMAIN}/`) produced a list that LOOKED complete and matched nothing. Everything
 * kept working on `app.{DOMAIN}` because better-auth also trusts the origin derived from
 * `baseURL` — so the only surface that broke was the one nothing was pointed at yet, and it broke
 * as a 403 INVALID_ORIGIN on sign-in. A1's e2e is what finally caught it.
 *
 * These assertions are deliberately about the STRING SHAPE, because that is what the bug was.
 */
describe('the platform trusted origins', () => {
  it('carries both platform hosts', () => {
    const origins = platformOrigins('http://app.souqbartaa.test');

    expect(origins).toContain(`http://${platformHost('app')}`);
    expect(origins).toContain(`http://${platformHost('admin')}`);
  });

  it('never ends in a slash — an Origin header does not, so a slash matches nothing', () => {
    for (const origin of platformOrigins('http://app.souqbartaa.test')) {
      expect(origin.endsWith('/')).toBe(false);
      // Round-tripping through URL is exactly what better-auth does to the incoming request.
      expect(new URL(origin).origin).toBe(origin);
    }
  });

  it('carries the port when the deployment has one, and omits it when it does not', () => {
    const ported = platformOrigins('http://app.souqbartaa.test:3100');
    expect(ported).toContain(`http://${platformHost('admin')}:3100`);

    const bare = platformOrigins('https://app.souqbartaa.test');
    expect(bare).toContain(`http://${platformHost('admin')}`);
  });

  it('degrades to the portless origins rather than throwing on a malformed base URL', () => {
    // The base URL is better-auth's to validate; this helper must not be the thing that crashes.
    expect(platformOrigins('not a url')).toContain(`http://${platformHost('admin')}`);
  });
});

/**
 * The OTHER half of the same mismatch, found by B2's e2e.
 *
 * `platformOrigins()` carries the port; `absoluteUrl()` did not. Every link a human opens on one
 * of our own hosts is built by `absoluteUrl` — password invitations, the impersonation handoff,
 * the Q18 export link, the demo link — and better-auth validates `callbackURL` against the
 * trusted origins. So in development and in the e2e stack the whole invitation path was dead:
 * the mail arrived, the link resolved, and better-auth answered `INVALID_CALLBACK_URL`.
 *
 * Production was fine, because there is no port there and the two agreed by accident — which is
 * exactly why it survived: the only environment where it worked was the one nobody builds in.
 */
describe('a link a human will open', () => {
  const withBaseUrl = async <T,>(
    value: string | undefined,
    fn: () => Promise<T>,
  ): Promise<T> => {
    const { resetEnvCache } = await import('@/env');
    const previous = process.env.BETTER_AUTH_URL;

    if (value === undefined) delete process.env.BETTER_AUTH_URL;
    else process.env.BETTER_AUTH_URL = value;
    resetEnvCache();

    try {
      // AWAITED inside the try. Returning the promise instead runs `finally` first, which
      // restores the environment before the callback has read it — and the test then measures
      // the ambient `.env` rather than the value it set.
      return await fn();
    } finally {
      if (previous === undefined) delete process.env.BETTER_AUTH_URL;
      else process.env.BETTER_AUTH_URL = previous;
      resetEnvCache();
    }
  };

  it('carries the port the platform actually answers on', async () => {
    const url = await withBaseUrl('http://app.souqbartaa.test:3100', async () => {
      const { absoluteUrl, platformHost: host } = await import('@/env');
      return absoluteUrl(host('app'), '/reset-password');
    });

    expect(url).toBe('http://app.souqbartaa.test:3100/reset-password');
  });

  it('matches a trusted origin exactly — the comparison better-auth makes', async () => {
    await withBaseUrl('http://app.souqbartaa.test:3100', async () => {
      const { absoluteUrl, platformHost: host } = await import('@/env');
      const link = absoluteUrl(host('app'), '/reset-password');

      expect(platformOrigins('http://app.souqbartaa.test:3100')).toContain(new URL(link).origin);
    });
  });

  it('omits the port in production, where there is none', async () => {
    const url = await withBaseUrl(undefined, async () => {
      const { absoluteUrl, platformHost: host } = await import('@/env');
      return absoluteUrl(host('app'), '/reset-password');
    });

    expect(url).toBe('http://app.souqbartaa.test/reset-password');
  });
});
