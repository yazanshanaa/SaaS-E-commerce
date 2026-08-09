import ranges from './cloudflare-ranges.json' with { type: 'json' };
import { getEnv } from '@/env';

/**
 * ONE central getClientIp() (invariant 9). Rate limiting and audit_logs use this and nothing
 * else.
 *
 * Why it cannot be a one-liner: this platform is reached two different ways.
 *   - Platform hostnames (admin.*, app.*, {slug}.*) sit behind the Cloudflare proxy, so the
 *     socket address is Cloudflare's and CF-Connecting-IP holds the visitor's.
 *   - Merchant CUSTOM domains point a CNAME straight at the server, bypassing Cloudflare
 *     entirely (Q7). There the socket address IS the visitor, and any CF-Connecting-IP header
 *     present was written by the visitor.
 *
 * So the header is trusted only after the peer is verified to be inside Cloudflare's published
 * ranges. Trusting it unconditionally would let anyone forge their own IP by sending a header
 * — which defeats rate limiting and poisons every audit row it touches.
 *
 * X-Forwarded-For is never trusted. It is trivially spoofable and, behind Cloudflare, it is
 * client-controlled: Cloudflare APPENDS to whatever the client sent.
 */

interface CidrV4 {
  base: number;
  mask: number;
}

interface CidrV6 {
  base: bigint;
  bits: number;
}

function parseIpv4(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;

  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    value = (value << 8) | n;
  }
  return value >>> 0;
}

function parseIpv6(ip: string): bigint | null {
  const zone = ip.indexOf('%');
  const clean = zone === -1 ? ip : ip.slice(0, zone);

  // ::ffff:1.2.3.4 — an IPv4 address wearing an IPv6 coat.
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(clean);
  if (mapped) {
    const v4 = parseIpv4(mapped[1]!);
    return v4 === null ? null : BigInt(v4);
  }

  const halves = clean.split('::');
  if (halves.length > 2) return null;

  const toGroups = (s: string): string[] => (s.length === 0 ? [] : s.split(':'));
  const head = toGroups(halves[0] ?? '');
  const tail = halves.length === 2 ? toGroups(halves[1] ?? '') : [];

  if (halves.length === 1 && head.length !== 8) return null;
  const fill = 8 - head.length - tail.length;
  if (fill < 0) return null;

  const groups = [...head, ...Array<string>(halves.length === 2 ? fill : 0).fill('0'), ...tail];
  if (groups.length !== 8) return null;

  let value = 0n;
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(group)) return null;
    value = (value << 16n) | BigInt(parseInt(group, 16));
  }
  return value;
}

function compileV4(cidrs: string[]): CidrV4[] {
  const out: CidrV4[] = [];
  for (const cidr of cidrs) {
    const [addr, bitsRaw] = cidr.split('/');
    const base = addr ? parseIpv4(addr) : null;
    const bits = Number(bitsRaw ?? 32);
    if (base === null || Number.isNaN(bits)) continue;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    out.push({ base: (base & mask) >>> 0, mask });
  }
  return out;
}

function compileV6(cidrs: string[]): CidrV6[] {
  const out: CidrV6[] = [];
  for (const cidr of cidrs) {
    const [addr, bitsRaw] = cidr.split('/');
    const base = addr ? parseIpv6(addr) : null;
    const bits = Number(bitsRaw ?? 128);
    if (base === null || Number.isNaN(bits)) continue;
    out.push({ base: base >> BigInt(128 - bits), bits });
  }
  return out;
}

const V4 = compileV4(ranges.v4);
const V6 = compileV6(ranges.v6);

/** Is this peer address inside Cloudflare's published ranges? */
export function isCloudflareIp(ip: string): boolean {
  const v4 = parseIpv4(ip);
  if (v4 !== null) {
    return V4.some((c) => ((v4 & c.mask) >>> 0) === c.base);
  }

  const v6 = parseIpv6(ip);
  if (v6 === null) return false;

  // A Cloudflare IPv4 arriving as ::ffff:x.x.x.x is still a Cloudflare IPv4.
  if (v6 <= 0xffffffffn) {
    const asV4 = Number(v6);
    if (V4.some((c) => ((asV4 & c.mask) >>> 0) === c.base)) return true;
  }

  return V6.some((c) => v6 >> BigInt(128 - c.bits) === c.base);
}

export interface ClientIpInput {
  /** Header accessor — `req.headers.get` semantics, case-insensitive. */
  headers: { get(name: string): string | null };
  /** The TCP peer address, from the platform (Node socket, or Caddy's X-Real-IP). */
  socketIp?: string | null;
}

export interface ClientIpResult {
  ip: string | null;
  /** `socket` when the peer was the client, `cloudflare` when a verified proxy reported it. */
  source: 'socket' | 'cloudflare' | 'unknown';
}

function normalise(ip: string | null | undefined): string | null {
  if (!ip) return null;
  const trimmed = ip.trim();
  if (!trimmed) return null;
  // ::ffff:1.2.3.4 is an IPv4 address; store it as one so rate-limit keys match.
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(trimmed);
  return mapped ? mapped[1]! : trimmed;
}

/**
 * Resolve the client IP. Returns `null` rather than a guess when nothing is trustworthy —
 * a wrong IP in an audit row is worse than a missing one, because it reads as evidence.
 */
export function getClientIp(input: ClientIpInput): ClientIpResult {
  const socketIp = normalise(input.socketIp ?? input.headers.get('x-real-ip'));
  const cfConnecting = normalise(input.headers.get('cf-connecting-ip'));

  if (getEnv().TRUST_CLOUDFLARE && cfConnecting && socketIp && isCloudflareIp(socketIp)) {
    return { ip: cfConnecting, source: 'cloudflare' };
  }

  if (socketIp) {
    return { ip: socketIp, source: 'socket' };
  }

  return { ip: null, source: 'unknown' };
}

/** Metadata for the pinned range file, so the refresh job can report staleness. */
export function cloudflareRangesMeta(): { fetchedAt: string; v4: number; v6: number } {
  return { fetchedAt: ranges.fetchedAt, v4: ranges.v4.length, v6: ranges.v6.length };
}
