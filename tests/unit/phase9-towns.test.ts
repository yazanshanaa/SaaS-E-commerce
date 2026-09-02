import { describe, expect, it } from 'vitest';
import {
  MAX_TOWNS_PER_ZONE,
  normaliseTownName,
  normalisesToNothing,
  parseTownList,
  parseTownNames,
  townNameField,
} from '@/server/delivery';

/**
 * `normaliseTownName` — Track D's load-bearing function.
 *
 * Every delivery price a customer is quoted depends on this agreeing with itself across two
 * keyboards: the merchant's, typing «الطيرة» into the zone editor, and the customer's, typing
 * «الطيره» into a checkout field on a phone. A miss here is not a cosmetic bug — it charges the
 * unlisted-town fee, or refuses the order, and the merchant is told their table is broken.
 *
 * So this file is deliberately over-specified. Real town names from the region, both directions of
 * every fold, the article rule at its boundary, and the adversarial inputs that produce a key the
 * database's own CHECK would reject.
 */

/** Real places, the way a merchant writes them and the way a customer types them. */
const REGION = [
  'الطيرة',
  'الطيبة',
  'أم الفحم',
  'باقة الغربية',
  'برطعة الغربية',
  'كفر قاسم',
  'جلجولية',
  'قلنسوة',
  'عرعرة',
  'كفر قرع',
  'أم القطف',
  'بير السكة',
  'مشيرفة',
] as const;

describe('normaliseTownName — the towns this platform actually serves', () => {
  it('produces a non-empty, trimmed key for every real town name', () => {
    for (const town of REGION) {
      const key = normaliseTownName(town);
      expect(key, town).not.toBe('');
      // `delivery_zone_towns` carries CHECK (length(normalised) > 0 AND normalised = btrim(...)).
      // A key that fails either half is a 500 at insert time, so both are asserted here.
      expect(key, town).toBe(key.trim());
    }
  });

  it('keeps distinct towns distinct — no fold may merge two real places', () => {
    const keys = REGION.map((town) => normaliseTownName(town));
    expect(new Set(keys).size).toBe(REGION.length);
  });

  it('is idempotent, which the seed relies on when it re-normalises a copied list', () => {
    for (const town of [...REGION, 'الطيــرة', '  أم   الفحم ', 'الطَّيبة']) {
      const once = normaliseTownName(town);
      expect(normaliseTownName(once), town).toBe(once);
    }
  });
});

describe('the folds, one at a time', () => {
  it('strips a leading ال — «الطيرة» and «طيرة» are the same place', () => {
    expect(normaliseTownName('الطيرة')).toBe(normaliseTownName('طيرة'));
    expect(normaliseTownName('الطيرة')).toBe('طيره');
  });

  it('refuses to strip ال when fewer than three characters would remain', () => {
    // «الله» is not a town, but it is the shape that proves the rule: stripping would leave «له».
    expect(normaliseTownName('الله')).toBe('الله');
    // «الجش» is a real village and keeps its article for the same arithmetic — the escape hatch is
    // the zone editor, where both spellings can be listed as two towns in one zone.
    expect(normaliseTownName('الجش')).toBe('الجش');
    expect(normaliseTownName('الجش')).not.toBe(normaliseTownName('جش'));
  });

  it('strips ال when exactly three characters remain', () => {
    expect(normaliseTownName('الرام')).toBe('رام');
    expect(normaliseTownName('العين')).toBe('عين');
  });

  it('folds all five alef forms to ا', () => {
    const folded = ['أم الفحم', 'إم الفحم', 'آم الفحم', 'ام الفحم', 'ٱم الفحم'].map(normaliseTownName);
    expect(new Set(folded).size).toBe(1);
    expect(folded[0]).toBe('ام الفحم');
  });

  it('folds ة to ه, ى to ي, ؤ to و and ئ to ي', () => {
    expect(normaliseTownName('الطيبة')).toBe(normaliseTownName('الطيبه'));
    expect(normaliseTownName('مشيرفى')).toBe('مشيرفي');
    expect(normaliseTownName('كفر مندؤ')).toBe('كفر مندو');
    // «العرائش» minus the article is «عرايش» — five characters, so the article goes and ئ folds.
    expect(normaliseTownName('العرائش')).toBe('عرايش');
  });

  it('removes tatweel and every diacritic, including one sitting between ا and ل', () => {
    expect(normaliseTownName('الطيــــرة')).toBe('طيره');
    expect(normaliseTownName('الطَّيرة')).toBe('طيره');
    // A fatha on the alef would hide the `ال` prefix from a regex that ran before the strip. The
    // order of operations in `normaliseTownName` is what this asserts.
    expect(normaliseTownName('اَلطيرة')).toBe('طيره');
    expect(normaliseTownName('الطيرةْ')).toBe('طيره');
  });

  it('collapses whitespace runs and trims', () => {
    expect(normaliseTownName('  كفر    قاسم  ')).toBe('كفر قاسم');
    expect(normaliseTownName('كفر\tقاسم')).toBe('كفر قاسم');
    expect(normaliseTownName('كفر\nقاسم')).toBe('كفر قاسم');
  });

  it('never leaves a leading space behind after stripping a standing-alone article', () => {
    // «ال طيرة» would leave « طيره», which the DB's btrim CHECK rejects outright.
    const key = normaliseTownName('ال طيرة');
    expect(key).toBe('طيره');
    expect(key).toBe(key.trim());
  });

  it('strips zero-width and bidi marks that survive a copy out of a chat message', () => {
    /**
     * THE INVISIBLE CHARACTERS BELOW ARE THE TEST. A merchant pastes a town name out of WhatsApp
     * and it arrives carrying a right-to-left mark, a byte-order mark or a zero-width space; the
     * matcher has to fold them away or the town silently stops matching and every cart in it
     * answers `town_not_served`.
     *
     * `no-irregular-whitespace` flags them on sight, which is right everywhere else in this
     * codebase and wrong here — "fixing" it by deleting the characters would leave three
     * assertions that pass against ordinary text and prove nothing at all.
     */
    /* eslint-disable no-irregular-whitespace */
    const withRlm = `‏الطيرة‏`;
    const withBom = `﻿الطيرة`;
    const withZwj = `الطي​رة`;
    /* eslint-enable no-irregular-whitespace */
    expect(normaliseTownName(withRlm)).toBe('طيره');
    expect(normaliseTownName(withBom)).toBe('طيره');
    expect(normaliseTownName(withZwj)).toBe('طيره');
  });

  it('folds Arabic presentation forms, which older systems and PDF copies emit', () => {
    // U+FEA9 is the isolated presentation form of د; NFKC maps it back to the ordinary letter.
    expect(normaliseTownName('ﺩالية')).toBe(normaliseTownName('دالية'));
  });

  it('leaves Latin and Hebrew alone, lowercasing only', () => {
    expect(normaliseTownName('Barta’a')).toBe('barta’a');
    expect(normaliseTownName('TEL AVIV')).toBe('tel aviv');
    // Hebrew has no case, so it must come through unchanged — a carrier's own sheet may spell a
    // town that way and mangling it would lose a row this function has no opinion about.
    expect(normaliseTownName('חדרה')).toBe('חדרה');
  });

  it('does NOT drop a standalone hamza — an over-fold here is unrecoverable from the UI', () => {
    // The unique index is (tenantId, normalised): merging two genuinely different towns into one
    // key would make it impossible to put them in different zones at any price. Under-folding only
    // costs a fallback-price match, so the risk is deliberately asymmetric.
    expect(normaliseTownName('جسر الزرقاء')).not.toBe(normaliseTownName('جسر الزرقا'));
  });
});

describe('inputs that normalise to nothing', () => {
  it('returns an empty key for whitespace, tatweel and bare diacritics', () => {
    for (const raw of ['', '   ', '\t\n', 'ـــ', 'ً', '‏‎', '﻿']) {
      expect(normaliseTownName(raw), JSON.stringify(raw)).toBe('');
      expect(normalisesToNothing(raw)).toBe(true);
    }
  });

  /**
   * THE reason this is a zod refusal and not only a database CHECK: a constraint violation reaches
   * the merchant as a 500 with a Latin error string, where a schema refusal reaches them as an
   * Arabic sentence telling them what to type instead.
   */
  it('is rejected by townNameField rather than stored', () => {
    expect(townNameField.safeParse('ـــ').success).toBe(false);
    expect(townNameField.safeParse('   ').success).toBe(false);
    expect(townNameField.safeParse('ً').success).toBe(false);
    expect(townNameField.safeParse('الطيرة').success).toBe(true);
  });

  it('names an i18n key rather than an English sentence when it refuses', () => {
    const failed = townNameField.safeParse('ـــ');
    expect(failed.success).toBe(false);
    if (!failed.success) {
      // Zod's own defaults are English. Every message in this track is `delivery:...`.
      expect(failed.error.issues[0]!.message).toMatch(/^delivery:/);
    }
  });

  it('refuses a name longer than the column allows', () => {
    expect(townNameField.safeParse('ا'.repeat(200)).success).toBe(false);
  });
});

describe('parseTownList — one textarea into a town list', () => {
  it('accepts newlines, Latin commas, Arabic commas and semicolons', () => {
    const parsed = parseTownList('الطيرة\nالطيبة، أم الفحم, كفر قاسم; جلجولية');
    expect(parsed.towns.map((town) => town.name)).toEqual([
      'الطيرة',
      'الطيبة',
      'أم الفحم',
      'كفر قاسم',
      'جلجولية',
    ]);
    expect(parsed.dropped).toBe(0);
    expect(parsed.truncated).toBe(false);
  });

  it('keeps the spelling the merchant typed and computes the key beside it', () => {
    const [town] = parseTownList('الطيره').towns;
    expect(town!.name).toBe('الطيره');
    expect(town!.normalised).toBe('طيره');
  });

  it('de-duplicates by KEY, not by string — «الطيرة» and «الطيره» are one town', () => {
    const parsed = parseTownList('الطيرة\nالطيره\nطيرة');
    expect(parsed.towns).toHaveLength(1);
    expect(parsed.towns[0]!.name).toBe('الطيرة');
    expect(parsed.dropped).toBe(2);
  });

  it('drops entries that normalise to nothing and counts them', () => {
    const parsed = parseTownList('الطيرة\nـــ\n   \nالطيبة');
    expect(parsed.towns).toHaveLength(2);
    // Blank lines are not "dropped" — they were never a name. Tatweel-only was.
    expect(parsed.dropped).toBe(1);
  });

  it('reports truncation rather than silently cutting the list', () => {
    const many = Array.from({ length: MAX_TOWNS_PER_ZONE + 5 }, (_, i) => `بلدة${i}`).join('\n');
    const parsed = parseTownList(many);
    expect(parsed.towns).toHaveLength(MAX_TOWNS_PER_ZONE);
    expect(parsed.truncated).toBe(true);
  });

  it('parseTownNames is the array-shaped twin, for the carrier rate copy', () => {
    expect(parseTownNames(['الطيرة', 'الطيره', 'الطيبة']).towns).toHaveLength(2);
  });
});
