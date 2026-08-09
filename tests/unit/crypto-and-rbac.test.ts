import { describe, expect, it } from 'vitest';
import {
  hashIp,
  hashPhone,
  hashSlug,
  hmac,
  randomToken,
  safeEqual,
  seal,
  shortId,
  signWebhookBody,
  unseal,
} from '@/server/crypto';
import { roleHasScope, MERCHANT_SCOPES } from '@/server/auth/rbac';
import { PUBLIC_ACTOR, SYSTEM_ACTOR, verifiedActor } from '@/server/db/actor';
import { parseHostname, isReservedSlug, normaliseHostname } from '@/server/tenancy';

describe('keyed hashing', () => {
  it('is deterministic under the same key', () => {
    expect(hashIp('203.0.113.9')).toBe(hashIp('203.0.113.9'));
  });

  it('does not reveal the input', () => {
    const hashed = hashIp('203.0.113.9');
    expect(hashed).not.toContain('203');
    expect(hashed.length).toBeGreaterThan(20);
  });

  it('DOMAIN-SEPARATES, so an ipHash never matches a phoneHash of the same text', () => {
    const value = '972599123456';
    expect(hashPhone(value)).not.toBe(hashIp(value));
    expect(hmac('a', value)).not.toBe(hmac('b', value));
  });

  it('normalises a phone number before hashing, so formatting does not fork the identity', () => {
    expect(hashPhone('+972-59-912-3456')).toBe(hashPhone('+972599123456'));
  });

  it('lowercases a slug before hashing, because a slug is case-insensitive', () => {
    expect(hashSlug('Abu-Ahmad')).toBe(hashSlug('abu-ahmad'));
  });
});

describe('tokens', () => {
  it('produces URL-safe tokens long enough that guessing is arithmetic, not a threat model', () => {
    const token = randomToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(token.length).toBeGreaterThanOrEqual(40);
  });

  it('never repeats', () => {
    const tokens = new Set(Array.from({ length: 200 }, () => randomToken()));
    expect(tokens.size).toBe(200);
  });

  it('generates human-quotable demo suffixes without ambiguous characters', () => {
    // A demo slug gets read aloud on a sales call; 0/O and 1/l are a support ticket.
    for (let i = 0; i < 50; i += 1) {
      expect(shortId()).toMatch(/^[abcdefghjkmnpqrstuvwxyz23456789]{6}$/);
    }
  });
});

describe('encryption at rest', () => {
  it('round-trips a secret', () => {
    const sealed = seal('gateway-api-key-12345');
    expect(sealed.cipher).not.toContain('gateway');
    expect(unseal(sealed)).toBe('gateway-api-key-12345');
  });

  it('uses a fresh IV every time, so identical plaintexts do not collide', () => {
    expect(seal('same').cipher).not.toBe(seal('same').cipher);
  });

  it('rejects a tampered ciphertext instead of returning garbage', () => {
    const sealed = seal('secret');
    const tampered = { ...sealed, cipher: Buffer.from('tampered').toString('base64') };
    expect(() => unseal(tampered)).toThrow();
  });

  it('handles Arabic plaintext', () => {
    expect(unseal(seal('مفتاح سري'))).toBe('مفتاح سري');
  });
});

describe('constant-time comparison and webhook signing', () => {
  it('compares equal and unequal values without leaking length by throwing', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });

  it('signs a webhook body deterministically and detects a changed byte', () => {
    const body = JSON.stringify({ type: 'subscription.suspended' });
    const signature = signWebhookBody('secret', body);

    expect(signature).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(signWebhookBody('secret', body)).toBe(signature);
    expect(signWebhookBody('secret', `${body} `)).not.toBe(signature);
    expect(signWebhookBody('other', body)).not.toBe(signature);
  });
});

describe('actors', () => {
  it('refuses an unknown role', () => {
    expect(() => verifiedActor('root' as never, null)).toThrow(/Unknown actor role/);
  });

  it('gives the two well-known actors no user and no privilege', () => {
    expect(PUBLIC_ACTOR.role).toBe('public');
    expect(PUBLIC_ACTOR.userId).toBeNull();
    expect(SYSTEM_ACTOR.role).toBe('system');
    // `system` is NOT super_admin: background work gets no cross-tenant reach.
    expect(SYSTEM_ACTOR.role).not.toBe('super_admin');
  });
});

describe('merchant RBAC (Q13)', () => {
  it('gives an owner everything', () => {
    for (const scope of MERCHANT_SCOPES) {
      expect(roleHasScope('owner', scope), scope).toBe(true);
    }
  });

  it('gives staff products, orders and media — and nothing else', () => {
    expect(roleHasScope('staff', 'products')).toBe(true);
    expect(roleHasScope('staff', 'media')).toBe(true);
    // The orders scope has no surface until Phase 5; the role does not need redefining then.
    expect(roleHasScope('staff', 'orders')).toBe(true);
  });

  it('NEVER lets staff near billing or the subscription', () => {
    expect(roleHasScope('staff', 'billing')).toBe(false);
    expect(roleHasScope('staff', 'subscription')).toBe(false);
    expect(roleHasScope('staff', 'export')).toBe(false);
    expect(roleHasScope('staff', 'domain')).toBe(false);
    expect(roleHasScope('staff', 'staff')).toBe(false);
    expect(roleHasScope('staff', 'appearance')).toBe(false);
  });
});

describe('hostname parsing', () => {
  it('normalises host headers', () => {
    expect(normaliseHostname('App.SouqBartaa.test:3000')).toBe('app.souqbartaa.test');
    expect(normaliseHostname(null)).toBe('');
  });

  it('never treats an infrastructure subdomain as a merchant slug', () => {
    // Otherwise n8n.{DOMAIN} would resolve to a storefront and the ops surface would be a 404
    // at best and a tenant lookup at worst.
    for (const reserved of ['n8n', 'umami', 'status', 'www', 'api', 'admin', 'app']) {
      expect(isReservedSlug(reserved), reserved).toBe(true);
    }
    expect(isReservedSlug('abu-ahmad')).toBe(false);
  });

  it('classifies the surfaces', () => {
    expect(parseHostname('admin.souqbartaa.test').surface).toBe('admin');
    expect(parseHostname('app.souqbartaa.test').surface).toBe('app');
    expect(parseHostname('shop.souqbartaa.test').slug).toBe('shop');
    expect(parseHostname('shop.example.com').isCustomDomain).toBe(true);
    expect(parseHostname('').surface).toBe('unknown');
  });
});
