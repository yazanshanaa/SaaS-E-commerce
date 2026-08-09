import { describe, expect, it } from 'vitest';
import { isWithinSchedule } from '@/shared/site-contract';
import {
  analyticsDecision,
  buildDefaultSections,
  buildOrderUrl,
  CUSTOM_HTML_FEATURE_KEY,
  fillOrderMessage,
  isCustomHtmlAllowed,
  isLegalSlug,
  legalHref,
  legalPagesFor,
  normaliseWhatsappNumber,
  resolveMapTarget,
} from '@/templates';
import { t } from '@/shared/i18n';

describe('the analytics rule (a compliance claim, not a preference)', () => {
  const base = { websiteId: 'w-1', scriptUrl: 'https://umami.example/script.js' };

  it('loads nothing on a first visit, before consent', () => {
    expect(
      analyticsDecision({ ...base, featureEnabled: true, consentGranted: false }).load,
    ).toBe(false);
  });

  it('loads nothing on an أساسي site EVEN WITH consent', () => {
    // The feature is off for basic. Consent cannot switch on something the plan does not have,
    // and this is the assertion behind "zero tracking requests, ever" for that plan.
    expect(analyticsDecision({ ...base, featureEnabled: false, consentGranted: true }).load).toBe(
      false,
    );
  });

  it('loads only when the feature AND consent AND a provisioned websiteId all line up', () => {
    const decision = analyticsDecision({ ...base, featureEnabled: true, consentGranted: true });
    expect(decision.load).toBe(true);
    expect(decision.websiteId).toBe('w-1');
  });

  it('fails soft when the platform has not provisioned Umami yet', () => {
    // No Umami instance is not an error on a storefront; the page renders, nothing is tracked.
    expect(
      analyticsDecision({ ...base, websiteId: null, featureEnabled: true, consentGranted: true })
        .load,
    ).toBe(false);
    expect(
      analyticsDecision({ ...base, scriptUrl: '  ', featureEnabled: true, consentGranted: true })
        .load,
    ).toBe(false);
  });
});

describe('the custom_html gate', () => {
  it('is bound to a pro-only availability key until a real one exists', () => {
    // There is no `custom_html` feature key in the frozen Phase 1 contract; adding one is a
    // sync point. Whatever this constant points at must FAIL CLOSED for أساسي and متجر.
    expect(CUSTOM_HTML_FEATURE_KEY).toBe('seo_tools');
  });

  it('refuses a demo tenant whatever the flag says', () => {
    expect(isCustomHtmlAllowed({ featureEnabled: true, isDemo: true })).toBe(false);
    expect(isCustomHtmlAllowed({ featureEnabled: true, isDemo: false })).toBe(true);
    expect(isCustomHtmlAllowed({ featureEnabled: false, isDemo: false })).toBe(false);
  });
});

describe('WhatsApp ordering (Q5 — no customer PII, no order row)', () => {
  it('accepts an international number and normalises punctuation away', () => {
    expect(normaliseWhatsappNumber('+972 50-000-0000')).toBe('972500000000');
    expect(normaliseWhatsappNumber('00970599123456')).toBe('970599123456');
  });

  it('REFUSES a local number rather than guessing a country code', () => {
    // Bartaa sits in the Seam Zone: `059…` could be +970 or +972, and a wrong guess sends a
    // customer's order to a stranger. The UI shows the phone number instead.
    expect(normaliseWhatsappNumber('0599123456')).toBeNull();
    expect(normaliseWhatsappNumber('050-000-0000')).toBeNull();
    expect(normaliseWhatsappNumber('')).toBeNull();
    expect(normaliseWhatsappNumber(null)).toBeNull();
  });

  it('builds the Arabic message from the catalogue with only the quantity left to fill', () => {
    const template = t('storefront', 'order.message', {
      shop: 'سوبر ماركت الوادي',
      product: 'زيت زيتون بلدي 3 لتر',
      price: '129 ₪',
      url: 'https://shop.example/products/olive-oil',
    });

    // Every parameter except {qty} is already substituted on the server.
    expect(template).toContain('زيت زيتون بلدي');
    expect(template).toContain('{qty}');

    const filled = fillOrderMessage(template, 3);
    expect(filled).toContain('3');
    expect(filled).not.toContain('{qty}');
  });

  it('opens wa.me with the encoded message and never posts anywhere', () => {
    const url = buildOrderUrl({ number: '972500000000', template: 'مرحباً {qty}' }, 2);
    expect(url.startsWith('https://wa.me/972500000000?text=')).toBe(true);
    expect(decodeURIComponent(url.split('text=')[1]!)).toBe('مرحباً 2');
  });

  it('never trusts a nonsense quantity', () => {
    expect(fillOrderMessage('{qty}', 0)).toBe('1');
    expect(fillOrderMessage('{qty}', -4)).toBe('1');
    expect(fillOrderMessage('{qty}', Number.NaN)).toBe('1');
    expect(fillOrderMessage('{qty}', 2.7)).toBe('2');
  });
});

describe('the map fallback chain (without it every demo renders a dead map)', () => {
  it('prefers coordinates and starts navigation in Waze', () => {
    const target = resolveMapTarget({ lat: 32.4772, lng: 35.1032 });
    expect(target?.kind).toBe('coordinates');
    expect(target?.googleUrl).toContain('32.4772%2C35.1032');
    expect(target?.wazeUrl).toContain('navigate=yes');
  });

  it('falls back to the section query, then Site.mapQuery, then the address', () => {
    expect(
      resolveMapTarget({ configQuery: 'برطعة — شارع السوق', siteQuery: 'برطعة', address: 'أ' })
        ?.value,
    ).toBe('برطعة — شارع السوق');

    // This is the demo-pack case exactly: address text on the site, nothing on the section.
    expect(resolveMapTarget({ siteQuery: 'برطعة — وسط السوق' })?.value).toBe('برطعة — وسط السوق');
    expect(resolveMapTarget({ address: 'برطعة — وسط السوق' })?.kind).toBe('query');
  });

  it('returns nothing at all rather than two links to an empty map', () => {
    expect(resolveMapTarget({})).toBeNull();
    expect(resolveMapTarget({ lat: 32.4, lng: null, siteQuery: '   ' })).toBeNull();
  });
});

describe('scheduling — the bar and the board share one rule', () => {
  const now = new Date('2026-08-10T12:00:00Z');

  it('hides anything outside its window', () => {
    expect(isWithinSchedule(now, '2026-08-11T00:00:00Z', null)).toBe(false);
    expect(isWithinSchedule(now, null, '2026-08-09T00:00:00Z')).toBe(false);
    expect(isWithinSchedule(now, '2026-08-01T00:00:00Z', '2026-08-31T00:00:00Z')).toBe(true);
    expect(isWithinSchedule(now, null, null)).toBe(true);
  });
});

describe('the permanent legal footer (placeholders Phase 6 fills)', () => {
  it('carries four links on every site and six once selling is enabled', () => {
    expect(legalPagesFor(false).map((page) => page.slug)).toEqual([
      'privacy',
      'terms',
      'business-identity',
      'accessibility',
    ]);

    const selling = legalPagesFor(true).map((page) => page.slug);
    expect(selling).toContain('returns');
    // The permanent "إلغاء معاملة" link, required the moment a site sells.
    expect(selling).toContain('cancel-transaction');
  });

  it('routes them all through /p/, which exists before Phase 6 writes a single row', () => {
    expect(legalHref('privacy')).toBe('/p/privacy');
    expect(isLegalSlug('accessibility')).toBe(true);
    expect(isLegalSlug('a-page-the-merchant-invented')).toBe(false);
  });
});

describe('default sections for a site nobody has arranged yet', () => {
  const everything = {
    hasProducts: true,
    hasCategories: true,
    hasAbout: true,
    hasTestimonials: true,
    hasAnnouncements: true,
    hasWhatsapp: true,
    hasLocation: true,
    gridColumns: 3 as const,
  };

  it('always leads with a hero, so the page has an h1', () => {
    expect(buildDefaultSections(everything)[0]?.type).toBe('hero');
  });

  it('omits every block with nothing behind it', () => {
    const bare = buildDefaultSections({
      hasProducts: false,
      hasCategories: false,
      hasAbout: false,
      hasTestimonials: false,
      hasAnnouncements: false,
      hasWhatsapp: false,
      hasLocation: false,
      gridColumns: 3,
    });

    // An empty "آراء الزبائن" heading looks broken in a way an absent one does not.
    expect(bare.map((section) => section.type)).toEqual(['hero']);
  });

  it('normalises through the same zod schemas a stored section goes through', () => {
    const grid = buildDefaultSections(everything).find((s) => s.type === 'products_grid');
    expect(grid?.config).toMatchObject({ limit: 12, columns: 3, showPrices: true });
  });

  it('keeps sort order contiguous so the renderer needs no re-sorting', () => {
    const sections = buildDefaultSections(everything);
    expect(sections.map((section) => section.sort)).toEqual(sections.map((_, index) => index));
  });
});
