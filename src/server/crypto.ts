import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { getEnv } from '@/env';

/**
 * One key, three jobs: keyed hashing of identifiers, symmetric encryption of stored secrets,
 * and opaque token generation.
 *
 * The keyed part matters more than it looks. A bare SHA-256 of an IPv4 address is not
 * anonymisation — the whole address space is 2^32 values, which is minutes of brute force on
 * a laptop. The same goes for a phone number. Anywhere this platform "hashes" an identifier
 * it is an HMAC under a secret the attacker does not have.
 */

function key(): Buffer {
  const raw = Buffer.from(getEnv().ENCRYPTION_KEY, 'base64');
  if (raw.length < 32) {
    throw new Error('ENCRYPTION_KEY must decode to at least 32 bytes.');
  }
  return raw.subarray(0, 32);
}

/**
 * Domain-separated HMAC. The domain string stops a value hashed in one context from matching
 * the same value hashed in another — an ipHash must never be comparable to a phoneHash.
 */
export function hmac(domain: string, value: string): string {
  return createHmac('sha256', key()).update(`${domain}:${value}`).digest('base64url');
}

/** DemoRequest.ipHash. Never store the address itself; never store a bare hash of it. */
export function hashIp(ip: string): string {
  return hmac('ip', ip);
}

/**
 * TenantTombstone.slugHash. Answers "was this slug ever used" without keeping the slug — a
 * small merchant's trading name is usually a person's name, and keeping it forever would
 * contradict the deletion the tombstone exists to prove.
 */
export function hashSlug(slug: string): string {
  return hmac('slug', slug.toLowerCase());
}

/** DsrRequest.subjectPhoneHash — a demo prospect reaches us by phone and has no account. */
export function hashPhone(phone: string): string {
  return hmac('phone', phone.replace(/[^\d+]/g, ''));
}

/** Storefront visitor identity for the consent record. Rotates with the salt the caller passes. */
export function hashVisitor(value: string): string {
  return hmac('visitor', value);
}

/**
 * A URL-safe opaque token. Used for the export download link, demo magic links and domain
 * verification. 32 bytes: guessing one is not a threat model, it is arithmetic.
 */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** Short, human-quotable suffix for demo slugs: `{slugPrefix}-{shortId}`. */
export function shortId(length = 6): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  const raw = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += alphabet[raw[i]! % alphabet.length];
  }
  return out;
}

export interface SealedValue {
  cipher: string;
  iv: string;
  tag: string;
}

/** AES-256-GCM. For payment gateway credentials (Phase 5) and anything else stored at rest. */
export function seal(plaintext: string): SealedValue {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key(), iv);
  const cipher = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
  return {
    cipher: cipher.toString('base64'),
    iv: iv.toString('base64'),
    tag: c.getAuthTag().toString('base64'),
  };
}

export function unseal(sealed: SealedValue): string {
  const d = createDecipheriv('aes-256-gcm', key(), Buffer.from(sealed.iv, 'base64'));
  d.setAuthTag(Buffer.from(sealed.tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(sealed.cipher, 'base64')), d.final()]).toString('utf8');
}

/** Constant-time comparison for anything a caller supplies and we compare to a stored value. */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/** HMAC-SHA256 signature for an outbound webhook body (`sha256=<hex>`). */
export function signWebhookBody(secret: string, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}
