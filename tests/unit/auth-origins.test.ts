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
