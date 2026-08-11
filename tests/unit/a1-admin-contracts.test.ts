import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseFeatureValue, FEATURE_KINDS } from '@/server/admin/access';
import { safeParseCapabilityPayload } from '@/server/admin/capability-payloads';
import { fieldErrorsFromZod, parseJerusalemInput } from '@/server/admin/validation';
import { createAccountSchema } from '@/server/admin/accounts';
import { FEATURE_KEYS, CAPABILITY_KEYS } from '@/shared/features';

/**
 * A1's contracts, checked without a database.
 *
 * Three of them exist because another track will consume them from a different worktree months
 * from now: the stored shape of a feature value, the change-request payload B2 has to produce,
 * and the promise that no admin screen writes lifecycle state itself.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

describe('feature values keep their stored shape', () => {
  it('covers every declared feature key', () => {
    expect(Object.keys(FEATURE_KINDS).sort()).toEqual([...FEATURE_KEYS].sort());
  });

  it('distinguishes unlimited (null) from zero', () => {
    // `change_requests_per_month = null` means UNLIMITED on احترافي. A parser that folded it to
    // 0 would block a pro merchant from ever requesting a change — and would look correct.
    const unlimited = parseFeatureValue('change_requests_per_month', { unlimited: true });
    expect(unlimited).toEqual({ ok: true, value: null });

    const none = parseFeatureValue('change_requests_per_month', { text: '0' });
    expect(none).toEqual({ ok: true, value: 0 });
  });

  it('reads an absent checkbox as OFF rather than as unchanged', () => {
    expect(parseFeatureValue('analytics', {})).toEqual({ ok: true, value: false });
    expect(parseFeatureValue('analytics', { boolean: true })).toEqual({ ok: true, value: true });
  });

  it('refuses a template key that is not in the registry', () => {
    expect(parseFeatureValue('templates_allowed', { list: ['diwan'] })).toEqual({
      ok: true,
      value: ['diwan'],
    });

    const bad = parseFeatureValue('templates_allowed', { list: ['not-a-template'] });
    expect(bad.ok).toBe(false);
  });

  it('refuses an empty template list — a tenant with no template has no site', () => {
    expect(parseFeatureValue('templates_allowed', { list: [] }).ok).toBe(false);
  });

  it('accepts only the two colour modes', () => {
    expect(parseFeatureValue('color_mode', { text: 'custom' })).toEqual({ ok: true, value: 'custom' });
    expect(parseFeatureValue('color_mode', { text: 'rainbow' }).ok).toBe(false);
  });

  it('refuses a negative or fractional limit', () => {
    expect(parseFeatureValue('products_limit', { text: '-1' }).ok).toBe(false);
    expect(parseFeatureValue('products_limit', { text: '1.5' }).ok).toBe(false);
    expect(parseFeatureValue('products_limit', { text: '30' })).toEqual({ ok: true, value: 30 });
  });
});

describe('the change-request payload contract B2 has to produce', () => {
  it('declares a schema for every managed capability', () => {
    for (const capabilityKey of CAPABILITY_KEYS) {
      expect(() => safeParseCapabilityPayload(capabilityKey, {})).not.toThrow();
    }
  });

  it('accepts the shapes A1 applies verbatim', () => {
    expect(
      safeParseCapabilityPayload('social_links', {
        links: [{ platform: 'instagram', url: 'https://instagram.com/shop', enabled: true }],
      }).success,
    ).toBe(true);

    expect(
      safeParseCapabilityPayload('map_location', {
        mapLat: 32.47,
        mapLng: 35.13,
        mapQuery: 'برطعة',
      }).success,
    ).toBe(true);

    expect(
      safeParseCapabilityPayload('colors', { mode: 'preset', presetKey: 'sahra' }).success,
    ).toBe(true);
  });

  it('refuses half a coordinate pair — one half alone points at the Gulf of Guinea', () => {
    expect(safeParseCapabilityPayload('map_location', { mapLat: 32.47, mapLng: null }).success).toBe(
      false,
    );
  });

  it('refuses a social link that is not an http(s) URL', () => {
    expect(
      safeParseCapabilityPayload('social_links', {
        links: [{ platform: 'instagram', url: 'javascript:alert(1)', enabled: true }],
      }).success,
    ).toBe(false);
  });
});

describe('dates entered in the panel are Asia/Jerusalem wall-clock times', () => {
  it('reads a bare date as the start of that local day, not as UTC midnight', () => {
    const parsed = parseJerusalemInput('2026-08-31');
    expect(parsed).toBeInstanceOf(Date);
    // Jerusalem is UTC+3 in August, so local midnight is 21:00 UTC on the previous day.
    expect(parsed!.toISOString()).toBe('2026-08-30T21:00:00.000Z');
  });

  it('rejects anything that is not a date', () => {
    expect(parseJerusalemInput('tomorrow')).toBeNull();
    expect(parseJerusalemInput('')).toBeNull();
  });
});

describe('validation messages are i18n keys, never sentences', () => {
  it('maps a zod failure onto namespaced keys', () => {
    const result = createAccountSchema.safeParse({
      name: 'x',
      slug: 'NOT A SLUG',
      ownerName: 'q',
      ownerEmail: 'not-an-email',
      planKey: '',
      billingPeriod: 'monthly',
      currentPeriodEnd: 'nope',
      templateKey: 'diwan',
      sendPasswordLink: false,
      address: '',
      phone: '',
      whatsapp: '',
    });

    expect(result.success).toBe(false);
    const errors = fieldErrorsFromZod(result.error!);
    expect(errors.length).toBeGreaterThan(0);

    for (const error of errors) {
      // `namespace:dotted.key` — anything else would put an English zod default on screen.
      expect(error.messageKey).toMatch(/^[a-z]+:[a-zA-Z.]+$/);
    }

    expect(errors.map((error) => error.field)).toContain('slug');
    expect(errors.map((error) => error.field)).toContain('ownerEmail');
  });
});

describe('invariant 5, from A1s side of the boundary', () => {
  function walk(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) out.push(...walk(full));
      else if (full.endsWith('.ts') || full.endsWith('.tsx')) out.push(full);
    }
    return out;
  }

  const adminSources = [
    ...walk(path.join(repoRoot, 'src', 'server', 'admin')),
    ...walk(path.join(repoRoot, 'src', 'app', 'admin')),
  ].map((file) => ({
    rel: path.relative(repoRoot, file).split(path.sep).join('/'),
    source: readFileSync(file, 'utf8'),
  }));

  it('creates a tenant nowhere in the admin panel — creation goes through the billing service', () => {
    const offenders = adminSources
      .filter(({ source }) => /\.tenant\.create\s*\(/.test(source))
      .map(({ rel }) => rel);

    expect(offenders).toEqual([]);
  });

  it('never writes a subscription row directly', () => {
    const offenders = adminSources
      .filter(({ source }) => /\.subscription\.(update|updateMany|create|upsert)\s*\(/.test(source))
      .map(({ rel }) => rel);

    expect(offenders).toEqual([]);
  });

  it('never writes a payment row directly — even the ₪25 add-on goes through billing', () => {
    const offenders = adminSources
      .filter(({ source }) => /\.payment\.(create|createMany|upsert)\s*\(/.test(source))
      .map(({ rel }) => rel);

    expect(offenders).toEqual([]);
  });

  it('resolves the client IP only through the central helper', () => {
    const offenders = adminSources
      .filter(({ source }) => /x-forwarded-for|cf-connecting-ip/i.test(source))
      .map(({ rel }) => rel);

    expect(offenders).toEqual([]);
  });

  /**
   * This replaces the placeholder that held the demo surface open for B3 ("builds no admin screen
   * for demos"), which went red the moment that track landed. It is deliberately NOT the
   * assertion `docs/decisions/b3.md` §1 proposed: `adminSources` above already walks
   * `src/app/admin/**`, so re-checking `demos/` for `.tenant.create` or `.subscription.update`
   * would restate the three tests above it over a smaller set of files.
   *
   * What the demo surface genuinely ADDS is a screen whose whole purpose is destroying a tenant.
   * Nothing above forbade that, because until B3 no admin screen could do it. «إغلاق النسخة»
   * must reach `billing.closeDemo()` — which quiesces the queues, sweeps R2 and writes the audit
   * row — and never a cascade issued from the route. A direct delete would look identical on
   * screen and leave the objects behind.
   */
  it('deletes a tenant nowhere in the admin panel — closing a demo goes through billing', () => {
    const offenders = adminSources
      .filter(({ source }) => /\.tenant\.delete(Many)?\s*\(/.test(source))
      .map(({ rel }) => rel);

    expect(offenders).toEqual([]);
  });
});
