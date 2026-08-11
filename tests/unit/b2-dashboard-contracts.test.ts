import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { SECTION_TYPES, type SectionType } from '@/shared/site-contract';
import { roleHasScope, MERCHANT_SCOPES } from '@/server/auth/rbac';
import {
  fieldErrorsFromZod,
  optionalDateField,
  optionalSlugField,
  optionalWhatsappField,
  priceField,
  slugCandidate,
} from '@/app/dashboard/_lib/validation';
import { SECTION_FIELDS } from '@/app/dashboard/sections/_config-form';

/**
 * The parts of B2 that are decidable without a database — and every one of them is a rule a
 * merchant would notice getting wrong.
 */

describe('money in, agorot out', () => {
  it('stores shekels as integer agorot', () => {
    expect(priceField.parse('19.90')).toBe(1_990);
    expect(priceField.parse('69')).toBe(6_900);
    expect(priceField.parse('1,250')).toBe(125_000);
  });

  it('accepts zero — "اسأل عن السعر" is a real way to sell a kitchen', () => {
    expect(priceField.parse('0')).toBe(0);
  });

  it('refuses a negative price and anything that is not a number', () => {
    expect(priceField.safeParse('-5').success).toBe(false);
    expect(priceField.safeParse('غالي').success).toBe(false);
  });

  it('rounds to the agora on the DIGIT, not on a float', () => {
    /**
     * The case that made this test worth writing: `19.955 * 100` is `1995.4999999999998` in
     * IEEE-754, so the obvious implementation rounds ₪19.955 DOWN to ₪19.95 while the same
     * number on paper rounds up. Deciding on the third decimal digit gives the answer a person
     * would give.
     */
    expect(priceField.parse('19.955')).toBe(1_996);
    expect(priceField.parse('19.954')).toBe(1_995);
    expect(Number.isInteger(priceField.parse('19.955'))).toBe(true);
  });

  it('never lets a float near the value, at any magnitude', () => {
    // 0.1 + 0.2 territory: these are the amounts where a multiply-and-round quietly loses an
    // agora, and a price list is thousands of them.
    expect(priceField.parse('1.005')).toBe(101);
    expect(priceField.parse('8.115')).toBe(812);
    expect(priceField.parse('1234.565')).toBe(123_457);
  });
});

describe('dates are Asia/Jerusalem wall-clock', () => {
  it('reads a bare date as the start of that day locally, not as UTC', () => {
    const parsed = optionalDateField.parse('2026-08-31');
    expect(parsed).not.toBeNull();

    // Israel is UTC+3 in August, so local midnight is 21:00 UTC on the PREVIOUS day. Reading
    // the input as UTC would have moved a scheduled offer to a different date entirely.
    expect(parsed!.toISOString()).toBe('2026-08-30T21:00:00.000Z');
  });

  it('treats an empty string as "no date" rather than as an error', () => {
    expect(optionalDateField.parse('')).toBeNull();
  });

  it('refuses something that is not a date', () => {
    expect(optionalDateField.safeParse('الأسبوع الجاي').success).toBe(false);
  });
});

describe('slugs', () => {
  it('builds one from a Latin name', () => {
    expect(slugCandidate('Blue Cotton Shirt', 'product', 'abc123')).toBe('blue-cotton-shirt');
  });

  it('falls back for an Arabic name instead of percent-encoding it', () => {
    /**
     * The slug is a URL segment, not a label — A2 renders `Product.name` everywhere a human
     * reads one. A percent-encoded Arabic path is unreadable in a WhatsApp message and mangled
     * by half the link previewers a merchant will send it through, which is the whole point of
     * having a slug at all.
     */
    expect(slugCandidate('قميص قطن أزرق', 'product', 'abc123')).toBe('product-abc123');
  });

  it('accepts a merchant-supplied slug only in the documented shape', () => {
    expect(optionalSlugField.parse('summer-sale')).toBe('summer-sale');
    expect(optionalSlugField.parse('')).toBeUndefined();
    expect(optionalSlugField.safeParse('Summer Sale').success).toBe(false);
    expect(optionalSlugField.safeParse('-leading').success).toBe(false);
  });
});

describe('WhatsApp numbers', () => {
  it('requires the international form the storefront link is built from', () => {
    expect(optionalWhatsappField.parse('+970599123456')).toBe('+970599123456');
    expect(optionalWhatsappField.parse('')).toBeUndefined();
    expect(optionalWhatsappField.safeParse('0599123456').success).toBe(false);
  });
});

describe('validation messages never reach a merchant in English', () => {
  it('maps a zod default onto our own key', () => {
    const schema = z.object({ name: z.string().min(3) });
    const parsed = schema.safeParse({ name: 'a' });
    expect(parsed.success).toBe(false);

    const errors = fieldErrorsFromZod(parsed.error!);
    expect(errors).toHaveLength(1);
    /**
     * Zod 4's own message is `Too small: expected string to have >=3 characters` — an English
     * sentence that CONTAINS A COLON, which is why the check is the key shape and not "does it
     * contain a separator". A substring test passed this straight through as though it were a
     * message we wrote.
     */
    expect(errors[0]!.messageKey).toBe('dashboard:errors.invalidValue');
  });

  it('keeps a key we wrote ourselves', () => {
    const parsed = priceField.safeParse('nope');
    expect(fieldErrorsFromZod(parsed.error!)[0]!.messageKey).toBe('dashboard:errors.invalidNumber');
  });
});

describe('the section settings form covers the contract', () => {
  it('has a field table for every section type', () => {
    // A section type with no entry renders an empty settings panel — a control that silently
    // does nothing, which is worse than an absent one.
    expect(Object.keys(SECTION_FIELDS).sort()).toEqual([...SECTION_TYPES].sort());
  });

  it('never asks a merchant to type a media id', () => {
    /**
     * `imageMediaId` and `mediaIds` are real fields in the contract and are deliberately absent
     * from the form: an image is chosen from the library, and a text box asking a shop owner for
     * a database identifier is worse than no control at all.
     */
    const named = Object.values(SECTION_FIELDS).flatMap((fields) => fields.map((f) => f.name));
    expect(named).not.toContain('imageMediaId');
    expect(named).not.toContain('mediaIds');
  });

  it('declares the numeric and boolean fields it needs coerced', () => {
    // The action reads booleans by PRESENCE (an unchecked box sends nothing) and coerces
    // numbers (zod refuses "12"). Both lists are derived from this table, so a field added
    // without its kind would silently stop saving.
    const grid = SECTION_FIELDS.products_grid;
    expect(grid.find((field) => field.name === 'showPrices')?.kind).toBe('boolean');
    expect(grid.find((field) => field.name === 'limit')?.kind).toBe('number');
  });
});

describe('Q13 — what a staff member may reach', () => {
  it('gives staff products, orders and media, and nothing else', () => {
    const allowed = MERCHANT_SCOPES.filter((scope) => roleHasScope('staff', scope));
    expect([...allowed].sort()).toEqual(['media', 'orders', 'products']);
  });

  it('never gives staff billing or the subscription', () => {
    // The nav hides them; this is the rule the ROUTES enforce, and it is the one that matters
    // when someone types a URL.
    expect(roleHasScope('staff', 'billing')).toBe(false);
    expect(roleHasScope('staff', 'subscription')).toBe(false);
    expect(roleHasScope('staff', 'export')).toBe(false);
    expect(roleHasScope('staff', 'staff')).toBe(false);
  });

  it('gives an owner everything', () => {
    for (const scope of MERCHANT_SCOPES) {
      expect(roleHasScope('owner', scope), scope).toBe(true);
    }
  });
});

describe('section types the dashboard knows about', () => {
  it('matches the contract exactly, in both directions', () => {
    const fromForm = Object.keys(SECTION_FIELDS) as SectionType[];
    for (const type of SECTION_TYPES) expect(fromForm).toContain(type);
    for (const type of fromForm) expect(SECTION_TYPES).toContain(type);
  });
});
