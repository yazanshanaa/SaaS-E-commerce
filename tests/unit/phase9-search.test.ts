import { describe, expect, it } from 'vitest';
import { normalisedContains, normaliseSearchTerm, searchTokens } from '@/server/search';

/**
 * Arabic normalisation is the whole of storefront search — there is no index, no stemmer and no
 * external engine behind it, so every match the box will ever make is decided by this one function.
 * It gets the heaviest test file in Track C.
 *
 * Each case names the real-world input it stands for. A rule with no failing customer behind it is a
 * rule that should not be there.
 */

describe('the definite article', () => {
  it('strips ال so a customer typing «الفستان» finds a product called «فستان»', () => {
    expect(normaliseSearchTerm('الفستان')).toBe('فستان');
    expect(normaliseSearchTerm('فستان')).toBe('فستان');
  });

  it('strips it from every word, because a phrase carries it more than once', () => {
    expect(normaliseSearchTerm('الفستان الاسود')).toBe('فستان اسود');
  });

  it('refuses to eat a short word that merely begins with those letters', () => {
    // «الو» is three characters; stripping would leave «و», which matches half the catalogue.
    expect(normaliseSearchTerm('الو')).toBe('الو');
    // «ألم» — a real word, and the alef fold must not turn it into a stripped «م».
    expect(normaliseSearchTerm('ألم')).toBe('الم');
  });

  it('strips it after the diacritics are gone, not before', () => {
    // «الْفستان» carries a sukun between the ل and the ف. Order matters: strip marks, then ال.
    expect(normaliseSearchTerm('الْفستان')).toBe('فستان');
  });
});

describe('letter folding', () => {
  it('folds all four alef forms to one', () => {
    // Note what does NOT happen here: «اسوره» begins with alef+seen, not alef+lam, so the article
    // rule leaves it alone. Four spellings, one comparison value.
    for (const spelling of ['اسورة', 'أسورة', 'إسورة', 'آسورة']) {
      expect(normaliseSearchTerm(spelling)).toBe('اسوره');
    }
  });

  it('folds teh marbuta to heh — «عباية» and «عبايه» are the same garment', () => {
    expect(normaliseSearchTerm('عباية')).toBe(normaliseSearchTerm('عبايه'));
  });

  it('folds alef maksura to yeh — «مصطفى» and «مصطفي» are the same name', () => {
    expect(normaliseSearchTerm('مصطفى')).toBe(normaliseSearchTerm('مصطفي'));
  });

  it('folds the hamza carriers and drops a standalone hamza', () => {
    expect(normaliseSearchTerm('مسؤول')).toBe('مسوول');
    expect(normaliseSearchTerm('رئيس')).toBe('رييس');
    expect(normaliseSearchTerm('ماء')).toBe('ما');
  });

  it('removes diacritics, so a merchant who vocalised a name has not hidden it', () => {
    expect(normaliseSearchTerm('مُبَرِّد')).toBe('مبرد');
  });

  it('removes tatweel, which is justification and carries no sound', () => {
    expect(normaliseSearchTerm('فســــتان')).toBe('فستان');
  });
});

describe('digits and Latin', () => {
  it('maps Arabic-Indic digits to Western ones — the keyboard may not match the price tag', () => {
    expect(normaliseSearchTerm('مقاس ٤٢')).toBe('مقاس 42');
    expect(normaliseSearchTerm('۴۲')).toBe('42');
  });

  it('lowercases Latin, so a brand name is findable however it was typed', () => {
    expect(normaliseSearchTerm('NIKE')).toBe('nike');
    expect(normaliseSearchTerm('Nike 42')).toBe('nike 42');
  });
});

describe('whitespace and punctuation', () => {
  it('collapses runs of whitespace and trims', () => {
    expect(normaliseSearchTerm('  فستان    سهرة  ')).toBe('فستان سهره');
  });

  it('treats punctuation as a word break, Arabic punctuation included', () => {
    expect(normaliseSearchTerm('فستان-سهرة')).toBe('فستان سهره');
    expect(normaliseSearchTerm('فستان، سهرة')).toBe('فستان سهره');
  });

  it('reduces a string of nothing but punctuation to the empty term', () => {
    // Which is what makes «؟؟؟» a non-search rather than a zero-result search worth reporting.
    expect(normaliseSearchTerm('؟؟؟')).toBe('');
    expect(normaliseSearchTerm('   ')).toBe('');
  });
});

describe('idempotence', () => {
  /**
   * Load-bearing rather than elegant: the ingest path normalises a term the search page has already
   * normalised. If a second pass changed the value, the merchant's report would group terms that the
   * search itself never matched.
   */
  it('is stable under a second application', () => {
    for (const input of [
      'الفستان الأسود',
      'مُبَرِّد ماء',
      'Nike 42',
      'عباية — مقاس ٤٢',
      '',
      'ال',
    ]) {
      const once = normaliseSearchTerm(input);
      expect(normaliseSearchTerm(once)).toBe(once);
    }
  });
});

describe('what it deliberately does NOT do', () => {
  it('does not stem: «كتاب» and «كتب» stay different words', () => {
    // Arabic morphology is templatic. A wrong stem produces confidently irrelevant results, which
    // loses a customer where a miss merely makes them try again.
    expect(normaliseSearchTerm('كتاب')).not.toBe(normaliseSearchTerm('كتب'));
  });

  it('does not fold plurals: «فساتين» is not «فستان»', () => {
    expect(normaliseSearchTerm('فساتين')).not.toBe(normaliseSearchTerm('فستان'));
  });
});

describe('tokens', () => {
  it('splits a normalised phrase into words', () => {
    expect(searchTokens('الفستان الأسود')).toEqual(['فستان', 'اسود']);
  });

  it('returns nothing for an unusable term rather than an array holding one empty string', () => {
    expect(searchTokens('   ')).toEqual([]);
    expect(searchTokens('')).toEqual([]);
  });
});

describe('normalisedContains', () => {
  it('matches across the folding — this is the comparison the matcher actually makes', () => {
    expect(normalisedContains('الفستان الأسود', 'فستان')).toBe(true);
    expect(normalisedContains('عباية سوداء', normaliseSearchTerm('عبايه'))).toBe(true);
  });

  it('never matches an empty needle, which would otherwise match everything', () => {
    expect(normalisedContains('أي منتج', '')).toBe(false);
  });
});
