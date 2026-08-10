import { describe, expect, it } from 'vitest';
import { effectiveHostHeader, isLoopbackHost } from '@/server/tenancy';

/**
 * Which hostname the proxy routes on.
 *
 * The bug this guards against was invisible from the browser: after any server action's
 * `redirect()`, Next re-requests the target through its OWN listener with `Host: localhost:{port}`,
 * so `parseHostname` read it as an unregistered custom domain and served the 404 page — while the
 * URL bar showed the correct address and a manual reload rendered the page perfectly. Every form
 * on every private surface redirects that way, so "submit anything, get told the address is not
 * registered" was the shipped behaviour.
 *
 * The other half matters just as much: `x-forwarded-host` is attacker-supplied on a public
 * request, so trusting it there would let a visitor pick which surface to be routed into.
 */

function headers(values: Record<string, string>): { get(name: string): string | null } {
  const lower = new Map(Object.entries(values).map(([k, v]) => [k.toLowerCase(), v]));
  return { get: (name: string) => lower.get(name.toLowerCase()) ?? null };
}

describe('isLoopbackHost', () => {
  it('recognises the forms a self-request actually arrives as', () => {
    for (const host of ['localhost', 'localhost:3000', '127.0.0.1', '127.0.0.1:3100', '::1', '[::1]:3100']) {
      expect(isLoopbackHost(host), host).toBe(true);
    }
  });

  it('does not mistake a real hostname for one', () => {
    for (const host of [
      'admin.souqbartaa.test',
      'app.souqbartaa.test:3100',
      'baqalat.souqbartaa.test',
      'localhost.evil.example',
      'notlocalhost',
      '',
      null,
    ]) {
      expect(isLoopbackHost(host), String(host)).toBe(false);
    }
  });
});

describe('effectiveHostHeader', () => {
  it('uses x-forwarded-host for a request that arrived on loopback', () => {
    const value = effectiveHostHeader(
      headers({ host: 'localhost:3100', 'x-forwarded-host': 'admin.souqbartaa.test:3100' }),
    );
    expect(value).toBe('admin.souqbartaa.test:3100');
  });

  it('IGNORES x-forwarded-host on a public request — it is client-supplied there', () => {
    // A visitor sending this must not be routed into the platform owner's tree.
    const value = effectiveHostHeader(
      headers({
        host: 'baqalat.souqbartaa.test',
        'x-forwarded-host': 'admin.souqbartaa.test',
      }),
    );
    expect(value).toBe('baqalat.souqbartaa.test');
  });

  it('takes the first entry when proxies have chained', () => {
    const value = effectiveHostHeader(
      headers({ host: '127.0.0.1:3100', 'x-forwarded-host': 'app.souqbartaa.test, internal.local' }),
    );
    expect(value).toBe('app.souqbartaa.test');
  });

  it('falls back to the Host it has when nothing was forwarded', () => {
    // The health probe hits 127.0.0.1 directly and carries no forwarded host.
    expect(effectiveHostHeader(headers({ host: '127.0.0.1:3100' }))).toBe('127.0.0.1:3100');
    expect(effectiveHostHeader(headers({ host: 'localhost:3100', 'x-forwarded-host': '  ' }))).toBe(
      'localhost:3100',
    );
  });
});
