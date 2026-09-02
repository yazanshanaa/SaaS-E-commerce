import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  STRIP_COLORS,
  homeStripSchema,
  parseSectionConfig,
  type SectionConfig,
} from '@/shared/site-contract';
import { getTemplate, type StorefrontContext } from '@/templates';
import {
  MAX_BANNERS,
  MAX_STORE_STATS,
  MAX_TRUST_BADGES,
  TIME_PATTERN,
  TRUST_ICON_KEYS,
  bannerInputSchema,
  fullWeek,
  isOpenNow,
  isRenderableBanner,
  jerusalemWallClock,
  openingHoursSchema,
  renderableBanners,
  renderableStoreStats,
  renderableTrustBadges,
  resolveStrip,
  storeStatInputSchema,
  stripStyle,
  trustBadgeInputSchema,
  type BannerRow,
  type OpeningHoursRow,
} from '@/server/content';
import {
  MediaPicker,
  type MediaPickerItem,
  type MediaPickerProps,
} from '@/app/dashboard/_components/media-picker';
import {
  BannerSliderSection,
  type StorefrontBanner,
} from '@/templates/sections/banner-slider';
import { TRUST_GLYPHS, TrustBadgesSection } from '@/templates/sections/trust-badges';
import { OpeningHoursSection } from '@/templates/sections/opening-hours';
import { StoreStatsSection } from '@/templates/sections/store-stats';
import { CategoryNav } from '@/templates/components/category-nav';
import { HomeStrip } from '@/templates/components/home-strip';
import { t } from '@/shared/i18n';

/**
 * Phase 9 Track B, the parts a unit test can actually prove.
 *
 * What is NOT here: anything that needs a database. The capability read-only branch producing a real
 * `ChangeRequest` row, and tenant isolation on the four new tables, live in
 * `tests/integration/phase9-content.test.ts` — a locked capability is a Redis-cached entitlement over
 * a Postgres row, and a mocked `canEdit` would be a test of the mock.
 *
 * What IS here is every rule that is pure: the banner publish gate, the schedule comparison, the
 * weekday and time validation, the strip colour map, the 160-character cap, and the one thing about
 * store stats worth guarding — that the value never becomes a number.
 */

// -----------------------------------------------------------------------------
// The banner publish gate — «بانر بلا صورة ما بيظهر»
// -----------------------------------------------------------------------------

const NOW = new Date('2026-08-14T09:00:00.000Z');

function bannerRow(overrides: Partial<BannerRow> = {}): BannerRow {
  return {
    id: 'b1',
    imageMediaId: 'm1',
    alt: 'فستان صيفي وردي على منصة عرض',
    title: 'خصم الصيف',
    subtitle: null,
    ctaLabel: null,
    ctaHref: null,
    sort: 0,
    published: true,
    startsAt: null,
    endsAt: null,
    ...overrides,
  };
}

describe('banner publish gate', () => {
  it('renders a published banner that has an image and a description', () => {
    expect(isRenderableBanner(bannerRow(), NOW)).toBe(true);
  });

  it('never renders a banner with no image, however published it is', () => {
    expect(isRenderableBanner(bannerRow({ imageMediaId: null }), NOW)).toBe(false);
  });

  it('never renders a banner with no Arabic description (invariant 4)', () => {
    expect(isRenderableBanner(bannerRow({ alt: null }), NOW)).toBe(false);
    // Whitespace is not a description. `SetNull` cannot produce this one; a merchant can.
    expect(isRenderableBanner(bannerRow({ alt: '   ' }), NOW)).toBe(false);
  });

  it('never renders a draft', () => {
    expect(isRenderableBanner(bannerRow({ published: false }), NOW)).toBe(false);
  });

  it('refuses to publish without an image or a description, in zod, with an Arabic key', () => {
    const noImage = bannerInputSchema.safeParse({
      imageMediaId: '',
      alt: 'وصف',
      title: 'عنوان',
      published: true,
    });
    expect(noImage.success).toBe(false);
    expect(noImage.error?.issues.map((issue) => issue.message)).toContain(
      'content:errors.bannerNeedsImage',
    );

    const noAlt = bannerInputSchema.safeParse({
      imageMediaId: 'm1',
      alt: '',
      title: 'عنوان',
      published: true,
    });
    expect(noAlt.success).toBe(false);
    expect(noAlt.error?.issues.map((issue) => issue.message)).toContain(
      'content:errors.bannerNeedsAlt',
    );
  });

  it('accepts a DRAFT with no image at all — that is the middle of writing one', () => {
    const draft = bannerInputSchema.safeParse({
      imageMediaId: '',
      alt: '',
      title: 'عنوان',
      published: false,
    });
    expect(draft.success).toBe(true);
  });

  it('refuses a CTA link that is not http(s) or a site-relative path', () => {
    for (const href of ['javascript:alert(1)', 'data:text/html,x', '//evil.test/x']) {
      const parsed = bannerInputSchema.safeParse({
        imageMediaId: 'm1',
        alt: 'وصف',
        title: 'عنوان',
        ctaHref: href,
      });
      expect(parsed.success, href).toBe(false);
    }

    for (const href of ['/products', 'https://example.test/x']) {
      const parsed = bannerInputSchema.safeParse({
        imageMediaId: 'm1',
        alt: 'وصف',
        title: 'عنوان',
        ctaHref: href,
      });
      expect(parsed.success, href).toBe(true);
    }
  });
});

describe('banner schedule windows', () => {
  it('hides a banner before its start and after its end', () => {
    const future = bannerRow({ startsAt: new Date('2026-09-01T00:00:00.000Z') });
    const past = bannerRow({ endsAt: new Date('2026-08-01T00:00:00.000Z') });

    expect(isRenderableBanner(future, NOW)).toBe(false);
    expect(isRenderableBanner(past, NOW)).toBe(false);
  });

  it('shows a banner inside its window, and treats an open bound as open', () => {
    expect(
      isRenderableBanner(
        bannerRow({
          startsAt: new Date('2026-08-01T00:00:00.000Z'),
          endsAt: new Date('2026-08-31T00:00:00.000Z'),
        }),
        NOW,
      ),
    ).toBe(true);
    expect(isRenderableBanner(bannerRow({ startsAt: new Date('2026-08-01T00:00:00.000Z') }), NOW)).toBe(
      true,
    );
  });

  it('is decided against the CLOCK IT IS GIVEN, never an internal one', () => {
    const banner = bannerRow({ endsAt: new Date('2026-08-13T00:00:00.000Z') });
    expect(isRenderableBanner(banner, new Date('2026-08-12T00:00:00.000Z'))).toBe(true);
    expect(isRenderableBanner(banner, NOW)).toBe(false);
  });

  it('sorts and caps, and never past the board ceiling', () => {
    const many = Array.from({ length: 10 }, (_, index) =>
      bannerRow({ id: `b${index}`, sort: 10 - index }),
    );
    const shown = renderableBanners(many, NOW, 99);

    expect(shown).toHaveLength(MAX_BANNERS);
    expect(shown[0]?.sort).toBe(1);
  });
});

// -----------------------------------------------------------------------------
// Opening hours: the weekday range, the time format, and the overnight window
// -----------------------------------------------------------------------------

function week(overrides: Partial<Record<number, Partial<OpeningHoursRow>>> = {}): OpeningHoursRow[] {
  return fullWeek(
    [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
      weekday,
      closed: false,
      opensAt: '09:00',
      closesAt: '20:00',
      ...(overrides[weekday] ?? {}),
    })),
  );
}

describe('opening hours validation', () => {
  it('refuses a weekday outside 0..6, matching the database CHECK', () => {
    for (const weekday of [-1, 7, 99]) {
      const parsed = openingHoursSchema.safeParse({
        days: [{ weekday, closed: true }],
        note: '',
      });
      expect(parsed.success, String(weekday)).toBe(false);
      expect(parsed.error?.issues.map((issue) => issue.message)).toContain(
        'content:errors.invalidWeekday',
      );
    }
  });

  it('refuses a time that is not zero-padded 24-hour "HH:mm", matching the database CHECK', () => {
    for (const time of ['9:00', '24:00', '23:60', '٠٩:٠٠', '09:00:00', 'noon']) {
      const parsed = openingHoursSchema.safeParse({
        days: [{ weekday: 0, closed: false, opensAt: time, closesAt: '20:00' }],
        note: '',
      });
      expect(parsed.success, time).toBe(false);
    }

    for (const time of ['00:00', '09:00', '23:59']) {
      const parsed = openingHoursSchema.safeParse({
        days: [{ weekday: 0, closed: false, opensAt: time, closesAt: '23:59' }],
        note: '',
      });
      // '23:59' → '23:59' is the equal-ends case, refused on its own grounds; everything else passes.
      expect(parsed.success, time).toBe(time !== '23:59');
    }

    // The zod pattern and the migration's are the same string, and this is what keeps them so.
    expect(TIME_PATTERN.source).toBe('^([01][0-9]|2[0-3]):[0-5][0-9]$');
  });

  it('refuses an open day with only one end filled in', () => {
    const parsed = openingHoursSchema.safeParse({
      days: [{ weekday: 0, closed: false, opensAt: '09:00', closesAt: '' }],
      note: '',
    });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map((issue) => issue.message)).toContain(
      'content:errors.hoursIncomplete',
    );
  });

  it('refuses a zero-length window but ACCEPTS a reversed one — 22:00 to 02:00 is a real shop', () => {
    const zero = openingHoursSchema.safeParse({
      days: [{ weekday: 0, closed: false, opensAt: '09:00', closesAt: '09:00' }],
      note: '',
    });
    expect(zero.success).toBe(false);

    const overnight = openingHoursSchema.safeParse({
      days: [{ weekday: 0, closed: false, opensAt: '22:00', closesAt: '02:00' }],
      note: '',
    });
    expect(overnight.success).toBe(true);
  });

  it('refuses a duplicated weekday, which the unique index would refuse louder', () => {
    const parsed = openingHoursSchema.safeParse({
      days: [
        { weekday: 3, closed: true },
        { weekday: 3, closed: false, opensAt: '09:00', closesAt: '20:00' },
      ],
      note: '',
    });
    expect(parsed.success).toBe(false);
  });

  it('ignores the two time columns on a closed day', () => {
    const parsed = openingHoursSchema.safeParse({
      days: [{ weekday: 5, closed: true, opensAt: 'nonsense', closesAt: '' }],
      note: '',
    });
    // The FORMAT still has to hold — the CHECK does not care whether the day is closed.
    expect(parsed.success).toBe(false);
  });

  it('fills the missing days as closed rather than showing a four-day week', () => {
    const filled = fullWeek([{ weekday: 2, closed: false, opensAt: '10:00', closesAt: '18:00' }]);
    expect(filled).toHaveLength(7);
    expect(filled.map((day) => day.weekday)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(filled[0]?.closed).toBe(true);
    expect(filled[2]?.opensAt).toBe('10:00');
  });
});

describe('«مفتوح الآن» in Asia/Jerusalem', () => {
  /**
   * Every instant below is written in UTC and asserted against the SHOP's clock, which is the whole
   * point: Israel is UTC+3 in August, so 07:00Z is 10:00 in Bartaa. Two earlier phases each shipped a
   * bug here by reading a wall-clock fact in UTC.
   */
  it('reads the weekday and the minute in the platform timezone, not in UTC', () => {
    // Friday 2026-08-14, 22:30 UTC = Saturday 01:30 in Jerusalem. Different day, different week row.
    const clock = jerusalemWallClock(new Date('2026-08-14T22:30:00.000Z'));
    expect(clock.weekday).toBe(6);
    expect(clock.minutes).toBe(1 * 60 + 30);
  });

  it('is open during the day and closed before opening, measured locally', () => {
    // Friday 2026-08-14 is weekday 5.
    const hours = week();
    expect(isOpenNow(hours, new Date('2026-08-14T09:00:00.000Z'))).toBe(true); // 12:00 local
    expect(isOpenNow(hours, new Date('2026-08-14T05:00:00.000Z'))).toBe(false); // 08:00 local
    expect(isOpenNow(hours, new Date('2026-08-14T18:00:00.000Z'))).toBe(false); // 21:00 local
  });

  it('honours a closed day', () => {
    expect(isOpenNow(week({ 5: { closed: true } }), new Date('2026-08-14T09:00:00.000Z'))).toBe(false);
  });

  it('keeps YESTERDAY’s overnight window open past midnight', () => {
    // Friday 22:00 → 02:00. At Saturday 00:30 local the shop is still on Friday's shift, and
    // Saturday's own row says nothing about it — the classic form of this bug.
    const hours = week({
      5: { opensAt: '22:00', closesAt: '02:00' },
      6: { closed: true },
    });

    expect(isOpenNow(hours, new Date('2026-08-14T20:00:00.000Z'))).toBe(true); // Fri 23:00 local
    expect(isOpenNow(hours, new Date('2026-08-14T21:30:00.000Z'))).toBe(true); // Sat 00:30 local
    expect(isOpenNow(hours, new Date('2026-08-14T23:30:00.000Z'))).toBe(false); // Sat 02:30 local
  });

  it('answers null — not false — when the week has never been filled in', () => {
    expect(isOpenNow([], NOW)).toBeNull();
    expect(isOpenNow(fullWeek([]), NOW)).toBeNull();
  });
});

// -----------------------------------------------------------------------------
// The strips
// -----------------------------------------------------------------------------

describe('strip colours', () => {
  it('resolves all four to TOKEN references, never to a colour literal', () => {
    for (const color of STRIP_COLORS) {
      const style = stripStyle(color);
      expect(style.background).toMatch(/^var\(--t-[a-z-]+\)$/);
      expect(style.color).toMatch(/^var\(--t-[a-z-]+\)$/);
    }
  });

  it('pairs each fill with the token that is contrast-guarded against it', () => {
    expect(stripStyle('primary')).toEqual({
      background: 'var(--t-primary)',
      color: 'var(--t-on-primary)',
    });
    expect(stripStyle('secondary')).toEqual({
      background: 'var(--t-secondary)',
      color: 'var(--t-on-secondary)',
    });
    // `dark` inverts the guarded text/background pair — contrast is symmetric, so it clears the same
    // 4.5:1 `deriveColorTokens` already enforced.
    expect(stripStyle('dark')).toEqual({ background: 'var(--t-text)', color: 'var(--t-bg)' });
    expect(stripStyle('light')).toEqual({
      background: 'var(--t-surface-alt)',
      color: 'var(--t-text)',
    });
  });

  it('falls back to dark for an unknown or missing stored value', () => {
    expect(stripStyle('chartreuse')).toEqual(stripStyle('dark'));
    expect(stripStyle(null)).toEqual(stripStyle('dark'));
    expect(stripStyle(undefined)).toEqual(stripStyle('dark'));
  });
});

describe('the mid-homepage strip', () => {
  const row = {
    enabled: true,
    text: 'توصيل مجاني لكل الضفة هذا الأسبوع',
    link: null,
    startsAt: null,
    endsAt: null,
    color: 'primary' as const,
  };

  it('caps the text at 160 characters — 200 of Arabic wraps to four lines on a phone', () => {
    expect(homeStripSchema.safeParse({ enabled: true, text: 'م'.repeat(160) }).success).toBe(true);
    expect(homeStripSchema.safeParse({ enabled: true, text: 'م'.repeat(161) }).success).toBe(false);
  });

  it('defaults to the primary colour, where the bar defaults to dark', () => {
    const parsed = homeStripSchema.parse({ enabled: false });
    expect(parsed.color).toBe('primary');
  });

  it('renders nothing when disabled, empty, or outside its window', () => {
    expect(resolveStrip({ ...row, enabled: false }, NOW)).toBeNull();
    expect(resolveStrip({ ...row, text: '   ' }, NOW)).toBeNull();
    expect(resolveStrip({ ...row, startsAt: new Date('2026-09-01T00:00:00.000Z') }, NOW)).toBeNull();
    expect(resolveStrip({ ...row, endsAt: new Date('2026-08-01T00:00:00.000Z') }, NOW)).toBeNull();
    expect(resolveStrip(null, NOW)).toBeNull();
  });

  it('carries the resolved token pair so the component never maps a colour itself', () => {
    const view = resolveStrip(row, NOW);
    expect(view?.style).toEqual(stripStyle('primary'));
    expect(view?.text).toBe(row.text);
  });

  it('renders a plain server strip: no dismiss button, no storage, no script', () => {
    const html = renderToStaticMarkup(
      createElement(HomeStrip, {
        text: 'توصيل مجاني',
        link: 'https://example.test/offer',
        style: stripStyle('dark'),
        regionLabel: 'شريط إعلاني',
      }),
    );

    expect(html).toContain('توصيل مجاني');
    expect(html).toContain('rel="noopener noreferrer nofollow"');
    expect(html).not.toContain('<button');
    expect(html).not.toContain('localStorage');
  });
});

// -----------------------------------------------------------------------------
// Trust badges and store stats
// -----------------------------------------------------------------------------

describe('trust badges', () => {
  it('has a glyph for every icon key the dashboard can offer', () => {
    for (const key of TRUST_ICON_KEYS) {
      expect(TRUST_GLYPHS[key], key).toBeTypeOf('function');
    }
  });

  it('has an Arabic label for every icon key', () => {
    for (const key of TRUST_ICON_KEYS) {
      expect(t('content', `badges.icons.${key}`)).toMatch(/[؀-ۿ]/);
    }
  });

  it('coerces an unknown icon key to `check` rather than failing a save', () => {
    const parsed = trustBadgeInputSchema.parse({ icon: 'unicorn', title: 'توصيل مجاني' });
    expect(parsed.icon).toBe('check');
  });

  it('drops unpublished rows and caps at four', () => {
    const rows = Array.from({ length: 8 }, (_, index) => ({
      id: `t${index}`,
      icon: 'truck',
      title: `سبب ${index}`,
      subtitle: null,
      sort: index,
      published: index !== 0,
    }));

    const shown = renderableTrustBadges(rows, 99);
    expect(shown).toHaveLength(MAX_TRUST_BADGES);
    expect(shown.some((badge) => badge.id === 't0')).toBe(false);
  });

  it('renders a real glyph and never an emoji', () => {
    const html = renderToStaticMarkup(
      createElement(TrustBadgesSection, {
        context: storefrontContext(),
        config: parseSectionConfig('trust_badges', {}) as SectionConfig<'trust_badges'>,
        badges: [
          { id: 't1', icon: 'truck', title: 'توصيل مجاني', subtitle: 'فوق ٤٠٠ شيكل' },
          { id: 't2', icon: 'wallet', title: 'ادفع لما توصلك', subtitle: null },
        ],
      }),
    );

    expect(html).toContain('توصيل مجاني');
    expect(html).toContain('<svg');
    expect(html).toContain('aria-hidden="true"');
    // The Emoji property escape is what catches a picture-character anywhere in the markup.
    expect(html).not.toMatch(/\p{Extended_Pictographic}/u);
  });
});

describe('store stats', () => {
  it('keeps the value a STRING — "7+" must not become 7', () => {
    for (const value of ['7+', '4000+', '100%', '٪١٠٠']) {
      const parsed = storeStatInputSchema.parse({ value, label: 'سنوات في السوق' });
      expect(parsed.value).toBe(value);
      expect(typeof parsed.value).toBe('string');
    }
  });

  it('renders the value verbatim, with no number formatting applied to it', () => {
    const html = renderToStaticMarkup(
      createElement(StoreStatsSection, {
        context: storefrontContext(),
        config: parseSectionConfig('store_stats', {}) as SectionConfig<'store_stats'>,
        stats: [
          { id: 's1', value: '7+', label: 'سنوات في السوق' },
          { id: 's2', value: '4000+', label: 'زبونة' },
        ],
      }),
    );

    expect(html).toContain('7+');
    expect(html).toContain('4000+');
    // `formatNumber('4000+')` would have produced a grouped "4,000" or a NaN.
    expect(html).not.toContain('4,000');
    expect(html).not.toContain('NaN');
  });

  it('drops unpublished and blank rows and caps at four', () => {
    const rows = [
      { id: 's1', value: '7+', label: 'سنوات', sort: 1, published: true },
      { id: 's2', value: '', label: 'فاضي', sort: 0, published: true },
      { id: 's3', value: '100%', label: 'رضا', sort: 2, published: false },
    ];

    const shown = renderableStoreStats(rows);
    expect(shown.map((stat) => stat.id)).toEqual(['s1']);
    expect(MAX_STORE_STATS).toBe(4);
  });

  it('renders nothing at all rather than a heading over blanks', () => {
    const html = renderToStaticMarkup(
      createElement(StoreStatsSection, {
        context: storefrontContext(),
        config: parseSectionConfig('store_stats', {}) as SectionConfig<'store_stats'>,
        stats: [],
      }),
    );
    expect(html).toBe('');
  });
});

// -----------------------------------------------------------------------------
// The banner slider section
// -----------------------------------------------------------------------------

describe('banner_slider', () => {
  function slide(id: string, withImage = true): StorefrontBanner {
    return {
      id,
      title: `بانر ${id}`,
      subtitle: null,
      ctaLabel: null,
      ctaHref: null,
      image: withImage
        ? {
            src: `https://cdn.test/${id}-card.webp`,
            sources: [{ type: 'image/avif', srcSet: `https://cdn.test/${id}-card.avif 800w` }],
            width: 1600,
            height: 900,
            alt: `وصف ${id}`,
          }
        : null,
    };
  }

  function render(props: {
    banners?: StorefrontBanner[];
    config?: Record<string, unknown>;
    context?: Partial<StorefrontContext>;
  }): string {
    return renderToStaticMarkup(
      createElement(BannerSliderSection, {
        context: storefrontContext(props.context),
        config: parseSectionConfig('banner_slider', props.config ?? {}) as SectionConfig<'banner_slider'>,
        ...(props.banners ? { banners: props.banners } : {}),
      }),
    );
  }

  it('re-checks the image at render, because SetNull can empty it after publication', () => {
    const html = render({ banners: [slide('a'), slide('b', false)] });
    expect(html).toContain('بانر a');
    expect(html).not.toContain('بانر b');
  });

  it('renders nothing when every slide lost its image', () => {
    expect(render({ banners: [slide('a', false)] })).toBe('');
    expect(render({ banners: [] })).toBe('');
  });

  it('server-renders the FIRST slide eagerly and lazy-loads the rest — the LCP rule', () => {
    const html = render({ banners: [slide('a'), slide('b'), slide('c')] });

    expect(html).toContain('loading="eager"');
    // React lower-cases the attribute on the way out (`fetchPriority` -> `fetchpriority`), so the
    // assertion has to be case-insensitive or it tests the prop name rather than the markup.
    expect(html.toLowerCase()).toContain('fetchpriority="high"');
    expect((html.match(/loading="eager"/g) ?? []).length).toBe(1);
    expect((html.match(/loading="lazy"/g) ?? []).length).toBe(2);
    // And the image markup is in the HTML, not produced after hydration.
    expect(html).toContain('https://cdn.test/a-card.webp');
  });

  it('reserves the box so a slide change cannot reflow the page', () => {
    const html = render({ banners: [slide('a')], config: { aspect: '4:5' } });
    expect(html).toContain('--sf-ratio:4 / 5');
    expect(html).toContain('width="1600"');
    expect(html).toContain('height="900"');
  });

  it('falls back to 16:9 when neither the config nor the template names an aspect', () => {
    /**
     * `TemplateLayout.bannerAspect` landed at Phase 9 integration and all three shipped templates
     * now set one, so the fallback is no longer reachable through a default `render()` — this used
     * to pass by the field not existing at all.
     *
     * It is still reachable, and still has to be: the field is OPTIONAL precisely so a template can
     * decline to have an opinion, and `16:9` is the only one of the three that does not push the
     * fold off a phone screen. So the template is stripped of its aspect here, which is the state
     * this assertion was always about.
     */
    const template = getTemplate('diwan');
    const { bannerAspect: _unset, ...layout } = template.layout;
    const withoutAspect = { ...template, layout } as StorefrontContext['template'];

    const html = render({ banners: [slide('a')], context: { template: withoutAspect } });
    expect(html).toContain('--sf-ratio:16 / 9');
  });

  it('prefers the template’s aspect over the fallback, and the config over both', () => {
    const template = getTemplate('diwan');
    const withAspect = {
      ...template,
      layout: { ...template.layout, bannerAspect: '1:1' },
    } as StorefrontContext['template'];

    expect(render({ banners: [slide('a')], context: { template: withAspect } })).toContain(
      '--sf-ratio:1 / 1',
    );
    expect(
      render({ banners: [slide('a')], config: { aspect: '4:5' }, context: { template: withAspect } }),
    ).toContain('--sf-ratio:4 / 5');
  });

  it('renders NO button when the CTA label is empty, and defaults the href when it is not', () => {
    const noCta = render({ banners: [slide('a')] });
    expect(noCta).not.toContain('class="sf-btn"');

    const labelOnly = render({
      banners: [{ ...slide('a'), ctaLabel: 'شوفي الجديد', ctaHref: null }],
    });
    expect(labelOnly).toContain('شوفي الجديد');
    expect(labelOnly).toContain('href="/products"');
  });

  it('exposes real prev/next controls with Arabic names, and no arrow glyph to mirror', () => {
    const html = render({ banners: [slide('a'), slide('b')] });
    expect(html).toContain(t('content', 'banners.previous'));
    expect(html).toContain(t('content', 'banners.next'));
    expect(html).toContain('role="group"');
    expect(html).toContain(`aria-roledescription="${t('content', 'banners.roleDescription')}"`);
  });

  it('offers no controls for a single slide — there is nowhere to go', () => {
    const html = render({ banners: [slide('a')] });
    expect(html).not.toContain(t('content', 'banners.next'));
  });
});

// -----------------------------------------------------------------------------
// Opening hours section
// -----------------------------------------------------------------------------

describe('opening_hours section', () => {
  function render(props: {
    days?: OpeningHoursRow[];
    note?: string | null;
    openNow?: boolean | null;
    config?: Record<string, unknown>;
  }): string {
    return renderToStaticMarkup(
      createElement(OpeningHoursSection, {
        context: storefrontContext(),
        config: parseSectionConfig('opening_hours', props.config ?? {}) as SectionConfig<'opening_hours'>,
        ...(props.days ? { days: props.days } : {}),
        ...(props.note !== undefined ? { note: props.note } : {}),
        ...(props.openNow !== undefined ? { openNow: props.openNow } : {}),
      }),
    );
  }

  it('prints the stored "HH:mm" strings, Sunday first, without reformatting them', () => {
    const html = render({ days: week({ 5: { opensAt: '10:00', closesAt: '14:30' } }) });

    expect(html).toContain('09:00');
    expect(html).toContain('14:30');
    // Sunday's label precedes Saturday's in the rendered order.
    expect(html.indexOf(t('content', 'hours.weekday.0'))).toBeLessThan(
      html.indexOf(t('content', 'hours.weekday.6')),
    );
  });

  it('says «مغلق» for a closed day', () => {
    const html = render({ days: week({ 5: { closed: true } }) });
    expect(html).toContain(t('content', 'hours.closedLabel'));
  });

  it('renders nothing for an unfilled week rather than claiming the shop has shut down', () => {
    expect(render({ days: fullWeek([]) })).toBe('');
    expect(render({ days: [] })).toBe('');
  });

  it('hides the open-now pill by default, because a wrong one is worse than none', () => {
    const html = render({ days: week(), openNow: true });
    expect(html).not.toContain(t('content', 'hours.openNow'));
  });

  it('shows the pill only when the merchant switched it on AND the answer is known', () => {
    expect(render({ days: week(), openNow: true, config: { showOpenNow: true } })).toContain(
      t('content', 'hours.openNow'),
    );
    expect(render({ days: week(), openNow: false, config: { showOpenNow: true } })).toContain(
      t('content', 'hours.closedNow'),
    );
    const unknown = render({ days: week(), openNow: null, config: { showOpenNow: true } });
    expect(unknown).not.toContain(t('content', 'hours.openNow'));
    expect(unknown).not.toContain(t('content', 'hours.closedNow'));
  });

  it('shows the footer note only when the section asks for it', () => {
    expect(render({ days: week(), note: 'أيام الجمعة بنسكّر بدري' })).toContain('بنسكّر بدري');
    expect(
      render({ days: week(), note: 'أيام الجمعة بنسكّر بدري', config: { showNote: false } }),
    ).not.toContain('بنسكّر بدري');
  });
});

// -----------------------------------------------------------------------------
// The category nav
// -----------------------------------------------------------------------------

describe('category nav', () => {
  function category(key: string, productCount: number) {
    return { key, name: `قسم ${key}`, productCount, image: null };
  }

  it('renders a flat link list with no dropdown machinery', () => {
    const html = renderToStaticMarkup(
      createElement(CategoryNav, {
        categories: [category('a', 4), category('b', 2)],
      }),
    );

    expect(html).toContain('href="/products?category=a"');
    expect(html).not.toContain('aria-expanded');
    expect(html).not.toContain('<button');
    expect(html).toContain(`aria-label="${t('content', 'nav.categories')}"`);
  });

  it('drops empty categories before the cap, so a slot is never spent on a dead end', () => {
    const html = renderToStaticMarkup(
      createElement(CategoryNav, {
        categories: [category('a', 4), category('empty', 0), category('b', 1)],
      }),
    );
    expect(html).not.toContain('category=empty');
  });

  it('collapses the tail into one catalogue link past the cap', () => {
    const html = renderToStaticMarkup(
      createElement(CategoryNav, {
        categories: Array.from({ length: 9 }, (_, index) => category(`c${index}`, 3)),
        limit: 6,
      }),
    );

    expect((html.match(/category=c/g) ?? []).length).toBe(6);
    expect(html).toContain(t('content', 'nav.allCategories'));
  });

  it('renders nothing for a shop with one stocked category — the header already links there', () => {
    expect(
      renderToStaticMarkup(createElement(CategoryNav, { categories: [category('a', 4)] })),
    ).toBe('');
  });
});

// -----------------------------------------------------------------------------
// The media picker
// -----------------------------------------------------------------------------

describe('media picker', () => {
  function item(overrides: Partial<MediaPickerItem> = {}): MediaPickerItem {
    return {
      id: 'm1',
      status: 'ready',
      previewUrl: 'https://cdn.test/m1-card.webp',
      altText: 'فستان وردي',
      originalName: 'dress.jpg',
      ...overrides,
    };
  }

  function render(props: Partial<MediaPickerProps> = {}): string {
    return renderToStaticMarkup(
      createElement(MediaPicker, {
        name: 'logoMediaId',
        items: [item()],
        label: 'الشعار',
        ...props,
      }),
    );
  }

  it('posts the chosen id under the field name — the checked input IS the field', () => {
    const html = render({ selectedIds: ['m1'] });
    expect(html).toContain('name="logoMediaId"');
    expect(html).toContain('value="m1"');
    expect(html).toContain('type="radio"');
    expect(html).toContain('checked');
  });

  it('needs no JavaScript and no storage: a details disclosure and native inputs', () => {
    const html = render();
    expect(html).toContain('<details');
    expect(html).toContain('<summary');
    expect(html).not.toContain('localStorage');
    expect(html).not.toContain('onclick');
  });

  it('labels the group and every option, which is what keeps axe quiet', () => {
    const html = render();
    expect(html).toContain('<fieldset');
    expect(html).toContain('<legend');
    expect(html).toContain('for="logoMediaId-m1"');
    expect(html).toContain('id="logoMediaId-m1"');
  });

  it('offers «بدون صورة» so a logo can be removed at all', () => {
    const html = render({ selectedIds: [] });
    expect(html).toContain('value=""');
    expect(html).toContain(t('content', 'picker.none'));
  });

  it('shows an unprocessed photo as «قيد المعالجة» and refuses to let it be chosen', () => {
    const html = render({ items: [item({ status: 'processing', previewUrl: null })] });
    expect(html).toContain(t('media', 'status.processing'));
    expect(html).toContain('disabled');
  });

  it('SURFACES missing alt text rather than hiding the photo (invariant 4)', () => {
    const html = render({ items: [item({ altText: null })], selectedIds: ['m1'] });
    expect(html).toContain(t('content', 'picker.noAlt'));
    expect(html).toContain(t('content', 'picker.altMissing'));
    // The photo is still offered — filtering it out would hide half a library with no explanation.
    expect(html).toContain('value="m1"');
  });

  it('switches to checkboxes for a multi-select field such as gallery.mediaIds', () => {
    const html = render({
      name: 'mediaIds',
      multiple: true,
      items: [item(), item({ id: 'm2', altText: 'حقيبة' })],
      selectedIds: ['m1', 'm2'],
    });

    expect(html).toContain('type="checkbox"');
    expect(html).not.toContain('type="radio"');
    expect(html).toContain(t('content', 'picker.selectedCount', { count: '2' }));
  });

  it('says so when the selection is older than the slice it was handed', () => {
    const html = render({ items: [item({ id: 'm9' })], selectedIds: ['m1'] });
    expect(html).toContain(t('content', 'picker.selectedElsewhere'));
  });

  it('renders an empty library as an empty state, not as a broken control', () => {
    const html = render({ items: [] });
    expect(html).toContain(t('content', 'picker.empty'));
  });
});

// -----------------------------------------------------------------------------

/** Enough of the view model to render one section. Copied from `phase9-catalogue.test.ts`. */
function storefrontContext(overrides: Partial<StorefrontContext> = {}): StorefrontContext {
  const template = getTemplate('diwan');

  return {
    tenantId: 'tenant-1',
    slug: 'diwan',
    hostname: 'diwan.souqbartaa.test',
    origin: 'https://diwan.souqbartaa.test',
    isDemo: false,
    pushPublicKey: null,
    credit: null,
    checkout: null,
    template,
    colors: {
      primary: template.tokens.color.primary,
      secondary: template.tokens.color.secondary,
      background: template.tokens.color.background,
      surface: template.tokens.color.surface,
      text: template.tokens.color.text,
    },
    site: {
      name: 'كوين ستايل',
      tagline: null,
      about: null,
      address: null,
      phone: null,
      whatsapp: null,
      hours: null,
      email: null,
      mapLat: null,
      mapLng: null,
      mapQuery: null,
      sellingEnabled: false,
      metaTitle: null,
      metaDescription: null,
      umamiWebsiteId: null,
      logo: null,
      ogImageUrl: null,
      faviconUrl: null,
      logoMediaId: null,
      pwaEnabled: false,
    },
    flags: {
      whatsappOrders: true,
      analytics: false,
      customHtml: false,
      pwa: false,
      push: false,
      payments: false,
      cart: false,
      // Phase 9. Both OFF, which is the state these assertions are about: what a storefront renders
      // for a tenant that has none of the new features.
      search: false,
      visitorAnalytics: false,
    },
    announcementBar: null,
    socialLinks: [],
    categories: [],
    products: [],
    productCountByCategory: {},
    productTotal: 0,
    productsByCategory: {},
    announcements: [],
    testimonials: [],
    mediaById: {},
    sections: [],
    hiddenSectionTypes: [],
    /*
      Phase 9's content, all EMPTY. Spelled out rather than left to the `...overrides` spread, which
      is what allowed this fixture to go stale: the spread of a `Partial` stops TypeScript checking
      the object for completeness, so a field added to the view model goes missing at runtime with
      nothing to say so. Empty is also the right default — it is the shape of a shop that has none
      of Phase 9's content, which every one of these blocks has to degrade to.
    */
    homeStrip: null,
    banners: [],
    trustBadges: [],
    storeStats: [],
    openingHours: [],
    hoursNote: null,
    openNow: null,
    newArrivals: [],
    bestSellers: [],
    ...overrides,
  };
}
