import { describe, expect, it } from 'vitest';
import { DEMO_PACKS, DEMO_PACK_KEYS, demoPack, isDemoPackKey } from '@/server/billing/demo-packs';
import { buildSectionRows, isSectionType } from '@/server/demo/sections';
import { svgPlaceholder } from '@/server/demo/placeholder';
import { assertProductImageAlt, isArabicText, sniffIngestible } from '@/server/media';
import { messageExists, t } from '@/shared/i18n';
import {
  AA_LARGE,
  AA_NORMAL,
  COLOR_PRESETS,
  TEMPLATE_KEYS,
  contrastRatio,
  isTemplateKey,
  parseSectionConfig,
  resolveColors,
} from '@/shared/site-contract';

/**
 * The packs are FROZEN DATA, and this file is what makes that safe.
 *
 * `src/server/demo/packs/**` cannot be edited by this track, and `buildDemoContent` consumes it
 * literally — so every assumption the builder makes about the shape of a pack has to be checked
 * against the real files rather than against the type. A `DemoPack` that typechecks can still name
 * a template A2 does not implement, a section the storefront cannot render, or a category no
 * product belongs to; all three would produce a demo that builds cleanly and looks broken in front
 * of a customer.
 *
 * It is a UNIT test on purpose: no database, no storage, no queue. Everything below is a fact about
 * three JSON files and the contracts they have to satisfy, and it should fail in the fastest
 * feedback loop available.
 */

const ARABIC = /[؀-ۿ]/;

describe('the frozen packs', () => {
  it('registers exactly the three keys the contract names', () => {
    expect([...DEMO_PACK_KEYS].sort()).toEqual(['clothing', 'food', 'industrial']);
    expect(isDemoPackKey('clothing')).toBe(true);
    expect(isDemoPackKey('carpentry')).toBe(false);
  });

  it.each(DEMO_PACK_KEYS)('%s: names a template A2 actually implements', (key) => {
    const pack = demoPack(key);
    expect(isTemplateKey(pack.template), `${pack.template} is not in ${TEMPLATE_KEYS.join(', ')}`).toBe(
      true,
    );
  });

  it.each(DEMO_PACK_KEYS)('%s: ships a full shop — 5 categories, 15 products, 3 testimonials', (key) => {
    const pack = demoPack(key);
    expect(pack.categories).toHaveLength(5);
    expect(pack.products).toHaveLength(15);
    expect(pack.testimonials).toHaveLength(3);
  });

  it.each(DEMO_PACK_KEYS)('%s: every product names a category the pack declares', (key) => {
    const pack = demoPack(key);
    const declared = new Set(pack.categories.map((category) => category.key));

    for (const product of pack.products) {
      expect(declared.has(product.category), `${product.sku} -> ${product.category}`).toBe(true);
    }
  });

  it.each(DEMO_PACK_KEYS)('%s: skus are unique, and usable as a product slug', (key) => {
    const pack = demoPack(key);
    const skus = pack.products.map((product) => product.sku);

    // `Product.slug` is unique per tenant and ends up in a URL; the builder uses the sku for both.
    expect(new Set(skus).size).toBe(skus.length);
    for (const sku of skus) expect(sku).toMatch(/^[a-z0-9][a-z0-9-]*$/);
  });

  it.each(DEMO_PACK_KEYS)('%s: prices are whole shekels that convert to exact agorot', (key) => {
    for (const product of demoPack(key).products) {
      expect(product.currency).toBe('ILS');
      expect(product.price).toBeGreaterThan(0);
      // No float ever reaches `price_agorot`; a price with a third decimal would round silently.
      expect(Math.round(product.price * 100)).toBe(product.price * 100);
    }
  });

  it.each(DEMO_PACK_KEYS)('%s: every image alt passes the mandatory Arabic rule', (key) => {
    for (const product of demoPack(key).products) {
      // The same function the builder calls, so a pack that fails here fails demo creation.
      expect(() => assertProductImageAlt(product.imageAlt)).not.toThrow();
      expect(isArabicText(product.imageAlt)).toBe(true);
    }
  });

  it.each(DEMO_PACK_KEYS)('%s: all human-facing copy is Arabic', (key) => {
    const pack = demoPack(key);

    expect(pack.label).toMatch(ARABIC);
    expect(pack.tenant.name).toMatch(ARABIC);
    expect(pack.tenant.tagline).toMatch(ARABIC);
    expect(pack.tenant.about).toMatch(ARABIC);
    for (const category of pack.categories) expect(category.name).toMatch(ARABIC);
    for (const product of pack.products) {
      expect(product.name).toMatch(ARABIC);
      expect(product.description).toMatch(ARABIC);
    }
    for (const testimonial of pack.testimonials) {
      expect(testimonial.name).toMatch(ARABIC);
      expect(testimonial.text).toMatch(ARABIC);
    }
  });

  it.each(DEMO_PACK_KEYS)('%s: slug prefix is a legal subdomain label', (key) => {
    expect(demoPack(key).tenant.slugPrefix).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });

  it('refuses an unknown pack rather than falling back to a default', () => {
    expect(() => demoPack('carpentry')).toThrow(/Unknown demo pack/);
  });

  /**
   * The picker's label exists in two places — `pack.label` in the frozen JSON and
   * `demo.packs.{key}` in the catalogue — and they drifted before this test existed (the seeded
   * catalogue said «مواد بناء ومعدات» where the pack says «عدد ومواد صناعية»). The pack cannot be
   * edited, so the catalogue is the side that follows, and this is what keeps it following.
   */
  it.each(DEMO_PACK_KEYS)('%s: the catalogue label matches the packs own', (key) => {
    expect(messageExists('demo', `packs.${key}`)).toBe(true);
    expect(t('demo', `packs.${key}`)).toBe(demoPack(key).label);
  });
});

describe('pack colours as vetted presets', () => {
  /**
   * Each pack's three colours are exactly one of the five vetted sets, which is what lets the
   * builder store a PRESET and keep all five tokens — above all `surface`, which a custom
   * selection collapses onto the background. If a pack ever stops matching, the builder falls back
   * to custom and the food demo's white cards quietly turn cream; this is the tripwire for that.
   */
  it.each(DEMO_PACK_KEYS)('%s: matches a preset exactly', (key) => {
    const pack = demoPack(key);
    const preset = COLOR_PRESETS.find(
      (candidate) =>
        candidate.primary.toLowerCase() === pack.colors.primary.toLowerCase() &&
        candidate.secondary.toLowerCase() === pack.colors.secondary.toLowerCase() &&
        candidate.background.toLowerCase() === pack.colors.background.toLowerCase(),
    );

    expect(preset, `${key} no longer matches any vetted preset`).toBeDefined();
    // The property the preset branch exists for: a surface distinct from the page behind it.
    expect(preset!.surface.toLowerCase()).not.toBe(preset!.background.toLowerCase());
  });
});

describe('pack colours through the contrast guard', () => {
  it.each(DEMO_PACK_KEYS)('%s: the stored tokens clear WCAG AA', (key) => {
    const pack = demoPack(key);
    const { colors } = resolveColors({
      mode: 'custom',
      primary: pack.colors.primary,
      secondary: pack.colors.secondary,
      background: pack.colors.background,
    });

    // Body text at 4.5:1; brand accents at the large-text threshold, which is what the guard
    // itself applies to `primary` and `secondary`.
    expect(contrastRatio(colors.text, colors.background)).toBeGreaterThanOrEqual(AA_NORMAL);
    expect(contrastRatio(colors.primary, colors.background)).toBeGreaterThanOrEqual(AA_LARGE);
    expect(contrastRatio(colors.secondary, colors.background)).toBeGreaterThanOrEqual(AA_LARGE);
  });
});

describe('pack sections against the site contract', () => {
  it.each(DEMO_PACK_KEYS)('%s: every section type is one the storefront renders', (key) => {
    for (const section of demoPack(key).sections) {
      expect(isSectionType(section.type), `${key}: ${section.type}`).toBe(true);
    }
  });

  it.each(DEMO_PACK_KEYS)('%s: rows come out in dense sort order, and every config validates', (key) => {
    const rows = buildSectionRows(demoPack(key));
    expect(rows.map((row) => row.sort)).toEqual(rows.map((_row, index) => index));

    for (const row of rows) {
      // Whatever is stored still satisfies the schema A2 re-parses it with at render time.
      expect(() => parseSectionConfig(row.type, row.config)).not.toThrow();
    }
  });

  it.each(DEMO_PACK_KEYS)('%s: keeps the grid keys the pack actually declares', (key) => {
    const grid = buildSectionRows(demoPack(key)).find((row) => row.type === 'products_grid');

    expect(grid).toBeDefined();
    expect(grid?.config.showPrices).toBe(true);
    // `showBadges` has no counterpart in the contract and is dropped; badges render unconditionally
    // from `Product.badge`, so the pack's intent is satisfied without it.
    expect(grid?.config).not.toHaveProperty('showBadges');
  });

  it('ships no custom_html — it renders nothing on a demo tenant, by design', () => {
    for (const key of DEMO_PACK_KEYS) {
      expect(demoPack(key).sections.some((section) => section.type === 'custom_html')).toBe(false);
    }
  });

  /**
   * The three keys where the frozen packs and the site contract use different names.
   *
   * Stored verbatim, `cta` and `note` are stripped by the contract's own schemas and the storefront
   * falls back to generic defaults — losing the pack's Arabic on the two blocks a prospect reads
   * first. This is the assertion that keeps `src/server/demo/sections.ts` honest; see
   * `docs/decisions/b3.md` for why the adaptation lives in the consumer and not in the data.
   */
  it('carries the packs own hero and contact copy onto the contract keys', () => {
    const pack = demoPack('clothing');
    const rows = buildSectionRows(pack);

    const heroSource = pack.sections.find((section) => section.type === 'hero');
    const hero = rows.find((row) => row.type === 'hero');
    expect(hero?.config.ctaLabel).toBe(heroSource?.config.cta);
    expect(hero?.config.ctaLabel).toMatch(ARABIC);

    const contactSource = pack.sections.find((section) => section.type === 'contact_whatsapp');
    const contact = rows.find((row) => row.type === 'contact_whatsapp');
    expect(contact?.config.body).toBe(contactSource?.config.note);
    expect(contact?.config.body).toMatch(ARABIC);
  });

  it('gives the map the requesters own address when the demo came from the form', () => {
    const pack = demoPack('food');
    const address = 'يعبد — شارع المدارس';

    const withRequester = buildSectionRows(pack, { address });
    const map = withRequester.find((row) => row.type === 'map');
    expect(map?.config.query).toBe(address);

    // …and the pack's own address when it did not.
    const withoutRequester = buildSectionRows(pack);
    const packMap = pack.sections.find((section) => section.type === 'map');
    expect(withoutRequester.find((row) => row.type === 'map')?.config.query).toBe(
      packMap?.config.query,
    );
  });

  it('refuses a section type the contract does not know, rather than storing a dead row', () => {
    const broken = { ...demoPack('food'), sections: [{ type: 'carousel', sort: 1, config: {} }] };
    expect(() => buildSectionRows(broken as never)).toThrow(/not in the site contract/);
  });
});

describe('the generated placeholder', () => {
  it.each(DEMO_PACK_KEYS)('%s: produces bytes the media pipeline accepts', (key) => {
    const pack = demoPack(key);
    const product = pack.products[0]!;
    const svg = svgPlaceholder(key, product.name, product.sku);
    const sniffed = sniffIngestible(Buffer.from(svg, 'utf8'));

    // The platform path accepts a vector; the merchant path does not. This is the whole reason
    // `ingestInternalImage` exists — bytes we generated a millisecond ago are a different question
    // from bytes a stranger uploaded.
    expect(sniffed.ok).toBe(true);
    expect(sniffed.ok && sniffed.mimeType).toBe('image/svg+xml');
  });

  it('escapes the product name rather than interpolating it into markup', () => {
    const svg = svgPlaceholder('food', '<script>alert(1)</script>', 'fd-01');
    expect(svg).not.toContain('<script>');
    expect(svg).toContain('&lt;script&gt;');
  });

  it('renders Arabic right-to-left', () => {
    const svg = svgPlaceholder('clothing', DEMO_PACKS.clothing.products[0]!.name, 'cl-01');
    expect(svg).toContain('direction="rtl"');
  });
});
