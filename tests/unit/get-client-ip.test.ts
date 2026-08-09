import { describe, expect, it } from 'vitest';
import { getClientIp, isCloudflareIp, cloudflareRangesMeta } from '@/server/http/get-client-ip';

/**
 * Invariant 9. Rate limiting and audit_logs use this and nothing else, so a wrong answer here
 * is either a rate limit an attacker walks around, or an audit row that names an innocent IP —
 * and the second is worse, because it reads as evidence.
 */

function headers(values: Record<string, string>) {
  const h = new Headers(values);
  return { get: (name: string) => h.get(name) };
}

// From the pinned range file. 173.245.48.0/20 is Cloudflare; 203.0.113.x is TEST-NET-3.
const CLOUDFLARE_PEER = '173.245.48.10';
const STRANGER_PEER = '203.0.113.7';
const VISITOR = '198.51.100.42';

describe('isCloudflareIp', () => {
  it('recognises a published Cloudflare range', () => {
    expect(isCloudflareIp(CLOUDFLARE_PEER)).toBe(true);
    expect(isCloudflareIp('104.16.0.1')).toBe(true);
  });

  it('rejects everything else', () => {
    expect(isCloudflareIp(STRANGER_PEER)).toBe(false);
    expect(isCloudflareIp('127.0.0.1')).toBe(false);
    expect(isCloudflareIp('not-an-ip')).toBe(false);
    expect(isCloudflareIp('')).toBe(false);
  });

  it('handles IPv6 and IPv4-mapped IPv6', () => {
    expect(isCloudflareIp('2400:cb00::1')).toBe(true);
    expect(isCloudflareIp('2001:db8::1')).toBe(false);
    // A Cloudflare IPv4 arriving as ::ffff:x.x.x.x is still a Cloudflare IPv4.
    expect(isCloudflareIp(`::ffff:${CLOUDFLARE_PEER}`)).toBe(true);
  });

  it('ships a non-empty pinned range file', () => {
    // An empty file would silently mean "trust nobody", which fails closed — but it would also
    // mean the refresh job wrote garbage, so it is worth asserting.
    const meta = cloudflareRangesMeta();
    expect(meta.v4).toBeGreaterThan(5);
    expect(meta.v6).toBeGreaterThan(3);
  });
});

describe('getClientIp — platform hostnames, behind the Cloudflare proxy', () => {
  it('trusts CF-Connecting-IP when the PEER is verified Cloudflare', () => {
    const result = getClientIp({
      headers: headers({ 'cf-connecting-ip': VISITOR }),
      socketIp: CLOUDFLARE_PEER,
    });

    expect(result.ip).toBe(VISITOR);
    expect(result.source).toBe('cloudflare');
  });
});

describe('getClientIp — merchant custom domains, which bypass Cloudflare entirely (Q7)', () => {
  it('IGNORES CF-Connecting-IP from an unverified peer', () => {
    // The header is trivially settable. Believing it would let anyone forge their own IP,
    // walking around every rate limit and poisoning every audit row they touch.
    const result = getClientIp({
      headers: headers({ 'cf-connecting-ip': '1.2.3.4' }),
      socketIp: STRANGER_PEER,
    });

    expect(result.ip).toBe(STRANGER_PEER);
    expect(result.source).toBe('socket');
  });

  it('uses the socket address when no proxy header is present', () => {
    const result = getClientIp({ headers: headers({}), socketIp: STRANGER_PEER });
    expect(result.ip).toBe(STRANGER_PEER);
    expect(result.source).toBe('socket');
  });
});

describe('getClientIp — X-Forwarded-For is never trusted', () => {
  it('ignores a spoofed X-Forwarded-For entirely', () => {
    const result = getClientIp({
      headers: headers({ 'x-forwarded-for': '10.0.0.1, 9.9.9.9' }),
      socketIp: STRANGER_PEER,
    });

    expect(result.ip).toBe(STRANGER_PEER);
  });

  it('ignores it even when the peer IS Cloudflare', () => {
    // Behind Cloudflare, XFF is client-controlled: Cloudflare APPENDS to whatever arrived.
    const result = getClientIp({
      headers: headers({ 'x-forwarded-for': '10.0.0.1', 'cf-connecting-ip': VISITOR }),
      socketIp: CLOUDFLARE_PEER,
    });

    expect(result.ip).toBe(VISITOR);
  });

  it('does not fall back to X-Forwarded-For when there is no socket address', () => {
    const result = getClientIp({ headers: headers({ 'x-forwarded-for': '10.0.0.1' }) });
    // null, not a guess. A wrong IP in an audit row is worse than a missing one.
    expect(result.ip).toBeNull();
    expect(result.source).toBe('unknown');
  });
});

describe('getClientIp — normalisation', () => {
  it('unwraps an IPv4-mapped IPv6 socket address so rate-limit keys match', () => {
    const result = getClientIp({ headers: headers({}), socketIp: `::ffff:${STRANGER_PEER}` });
    expect(result.ip).toBe(STRANGER_PEER);
  });

  it('falls back to X-Real-IP, which Caddy sets from the actual peer', () => {
    const result = getClientIp({ headers: headers({ 'x-real-ip': STRANGER_PEER }) });
    expect(result.ip).toBe(STRANGER_PEER);
    expect(result.source).toBe('socket');
  });
});
