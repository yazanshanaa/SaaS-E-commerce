import { describe, expect, it } from 'vitest';
import {
  beaconBodySchema,
  beaconDecision,
  clampDwell,
  daySalt,
  deviceKindFrom,
  isKnownSectionAnchor,
  loadInsights,
  MAX_EVENTS_PER_BEACON,
  MAX_SEARCH_TERM_LENGTH,
  normaliseEvent,
  normalisePath,
  rollupTenantDay,
  SITE_TOTAL_PATH,
  UNKNOWN_PATH,
  utcDay,
  visitorKey,
} from '@/server/analytics';
import type { ScopedDb, TenantTx } from '@/server/db';

/**
 * Track C's pure surface. Everything here runs with no Postgres and no Redis, which is the point:
 * the privacy claim, the bounds and the rollup arithmetic are the parts that must be right, and a
 * test that needs infrastructure to check that nine hours becomes two minutes is a test nobody runs.
 *
 * The database-backed half — RLS, the `zero_results <= searches` CHECK, the real aggregation — is in
 * `tests/integration/phase9-analytics.test.ts`.
 */

const A_DAY = new Date('2026-08-14T10:30:00.000Z');
const NEXT_DAY = new Date('2026-08-15T00:05:00.000Z');
const CHROME_ANDROID =
  'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36';
const FIREFOX_DESKTOP = 'Mozilla/5.0 (X11; Linux x86_64; rv:120.0) Gecko/20100101 Firefox/120.0';

// -----------------------------------------------------------------------------

describe('the visitor key — the privacy core of Q20', () => {
  it('is 32 hex characters, and nothing else', () => {
    const key = visitorKey({ ip: '203.0.113.7', userAgent: CHROME_ANDROID, now: A_DAY });
    expect(key).toMatch(/^[0-9a-f]{32}$/);
  });

  it('is stable for the same visitor within one day — otherwise it could not count', () => {
    const first = visitorKey({ ip: '203.0.113.7', userAgent: CHROME_ANDROID, now: A_DAY });
    const second = visitorKey({
      ip: '203.0.113.7',
      userAgent: CHROME_ANDROID,
      now: new Date('2026-08-14T23:59:59.000Z'),
    });
    expect(second).toBe(first);
  });

  it('ROTATES with the day, so no query can follow one person across days', () => {
    // This is the whole difference between a counting device and an identifier. If this test ever
    // fails, `visitors` has stopped being a count and started being a profile.
    const today = visitorKey({ ip: '203.0.113.7', userAgent: CHROME_ANDROID, now: A_DAY });
    const tomorrow = visitorKey({ ip: '203.0.113.7', userAgent: CHROME_ANDROID, now: NEXT_DAY });
    expect(tomorrow).not.toBe(today);
  });

  it('separates two visitors who differ only by address, and only by user agent', () => {
    const base = visitorKey({ ip: '203.0.113.7', userAgent: CHROME_ANDROID, now: A_DAY });
    expect(visitorKey({ ip: '203.0.113.8', userAgent: CHROME_ANDROID, now: A_DAY })).not.toBe(base);
    expect(visitorKey({ ip: '203.0.113.7', userAgent: FIREFOX_DESKTOP, now: A_DAY })).not.toBe(base);
  });

  it('does not leak either input — the key contains no substring of the address', () => {
    const key = visitorKey({ ip: '203.0.113.7', userAgent: CHROME_ANDROID, now: A_DAY });
    expect(key).not.toContain('203');
    expect(key).not.toContain('113');
    expect(key.toLowerCase()).not.toContain('android');
  });

  it('collapses every untrustworthy address onto ONE key per day, never dropping the event', () => {
    // `getClientIp()` returns null rather than a guess. "One unknown visitor" is the honest reading;
    // dropping the row would silently under-count a whole class of traffic.
    const a = visitorKey({ ip: null, userAgent: CHROME_ANDROID, now: A_DAY });
    const b = visitorKey({ ip: null, userAgent: CHROME_ANDROID, now: A_DAY });
    expect(a).toBe(b);
    expect(a).not.toBe(visitorKey({ ip: null, userAgent: CHROME_ANDROID, now: NEXT_DAY }));
  });

  it('salts on the UTC day, so the salt and the rollup grouping agree', () => {
    // Local time would rotate three hours before the boundary the rollup counts to in Asia/Jerusalem,
    // and every evening's visitor would be counted twice.
    expect(daySalt(new Date('2026-08-14T22:30:00.000Z'))).toBe('2026-08-14');
    expect(daySalt(new Date('2026-08-15T00:00:00.000Z'))).toBe('2026-08-15');
  });
});

describe('device kind', () => {
  it('reads two values and only two', () => {
    expect(deviceKindFrom(CHROME_ANDROID)).toBe('mobile');
    expect(deviceKindFrom(FIREFOX_DESKTOP)).toBe('desktop');
    expect(deviceKindFrom('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)')).toBe('mobile');
  });

  it('treats an absent user agent as desktop rather than guessing the majority case', () => {
    expect(deviceKindFrom(null)).toBe('desktop');
    expect(deviceKindFrom('')).toBe('desktop');
  });
});

describe('the two gates', () => {
  it('needs BOTH — the feature alone is never enough', () => {
    expect(beaconDecision({ featureEnabled: true, consentGranted: false }).enabled).toBe(false);
  });

  it('needs BOTH — consent alone is never enough either', () => {
    // A tenant without `visitor_analytics` must issue zero measurement requests EVEN WITH a consent
    // record. That is a compliance claim, not a preference.
    expect(beaconDecision({ featureEnabled: false, consentGranted: true }).enabled).toBe(false);
  });

  it('allows measurement only when both hold', () => {
    expect(beaconDecision({ featureEnabled: true, consentGranted: true }).enabled).toBe(true);
    expect(beaconDecision({ featureEnabled: false, consentGranted: false }).enabled).toBe(false);
  });
});

describe('path normalisation — a closed set, not a sanitiser', () => {
  it('keeps the shapes the storefront actually has', () => {
    expect(normalisePath('/')).toBe('/');
    expect(normalisePath('/products')).toBe('/products');
    expect(normalisePath('/cart')).toBe('/cart');
    expect(normalisePath('/checkout')).toBe('/checkout');
    expect(normalisePath('/search')).toBe('/search');
  });

  it('collapses a product slug, which is where the cardinality would have come from', () => {
    expect(normalisePath('/products/fustan-sahra')).toBe('/products/:slug');
    expect(normalisePath('/p/privacy')).toBe('/p/:slug');
  });

  it('collapses a tracking code — that one is privacy, not cardinality', () => {
    // A tracking code is a per-order secret handed to one customer. Keeping it would put a working
    // order link inside a report the merchant prints.
    expect(normalisePath('/order/AB12CD34')).toBe('/order/:code');
  });

  it('drops the query string and the fragment, in that order', () => {
    expect(normalisePath('/products?category=dresses&utm_source=x')).toBe('/products');
    expect(normalisePath('/products?a=1#offers')).toBe('/products');
    expect(normalisePath('/#offers')).toBe('/');
  });

  it('treats a trailing slash as the same page, and keeps the root usable', () => {
    expect(normalisePath('/products/')).toBe('/products');
    expect(normalisePath('/')).toBe('/');
  });

  it("strips the proxy's internal /site prefix", () => {
    // A service worker replaying a fetch reports the rewritten form; it means the same page.
    expect(normalisePath('/site/products')).toBe('/products');
    expect(normalisePath('/site')).toBe('/');
  });

  it('accepts a full URL, because location.href is what a client sends by accident', () => {
    expect(normalisePath('https://shop.souqbartaa.test/products/abc?x=1')).toBe('/products/:slug');
  });

  it('buckets anything it does not recognise, so the column can never grow unbounded', () => {
    expect(normalisePath('/wp-admin/setup-config.php')).toBe(UNKNOWN_PATH);
    expect(normalisePath('/products/a/b/c')).toBe(UNKNOWN_PATH);
    expect(normalisePath('not-a-path')).toBe(UNKNOWN_PATH);
    expect(normalisePath('')).toBe(UNKNOWN_PATH);
    expect(normalisePath(undefined)).toBe(UNKNOWN_PATH);
    expect(normalisePath(`/${'a'.repeat(500)}`)).toBe(UNKNOWN_PATH);
  });

  it('never returns the reserved site-total path', () => {
    // `SITE_TOTAL_PATH` is a rollup row, not a page. If normalisation could produce it, one page's
    // count would silently replace the day's visitor total.
    for (const input of ['*', '/*', '/site/*', 'https://x.test/*']) {
      expect(normalisePath(input)).not.toBe(SITE_TOTAL_PATH);
    }
  });
});

describe('section targets — the tenant’s own anchors and nothing else', () => {
  it('accepts an anchor the platform renders', () => {
    expect(isKnownSectionAnchor('products')).toBe(true);
    expect(isKnownSectionAnchor('about')).toBe(true);
    expect(isKnownSectionAnchor('location')).toBe(true);
  });

  it('accepts the occurrence suffix anchorFor() emits for a repeated block', () => {
    // Phase 6's legal pages are eight `about` blocks on one page.
    expect(isKnownSectionAnchor('about-2')).toBe(true);
    expect(isKnownSectionAnchor('about-8')).toBe(true);
  });

  it('rejects `-1`, which anchorFor() never emits — the first block keeps the bare anchor', () => {
    expect(isKnownSectionAnchor('about-1')).toBe(false);
  });

  it('bounds the suffix, so a number cannot become a rollup row per value', () => {
    expect(isKnownSectionAnchor('about-999999999')).toBe(false);
  });

  it('rejects an unknown name and every shape of hostile input', () => {
    // An open text field here is unbounded cardinality AND a stored-XSS vector, because the merchant
    // report renders the value.
    expect(isKnownSectionAnchor('whatever')).toBe(false);
    expect(isKnownSectionAnchor('<script>alert(1)</script>')).toBe(false);
    expect(isKnownSectionAnchor('about<img onerror=x>')).toBe(false);
    expect(isKnownSectionAnchor('')).toBe(false);
  });
});

describe('dwell clamping', () => {
  it('floors at zero, because a client clock can step backwards mid-visit', () => {
    // The DB has CHECK (dwell_ms >= 0); an unclamped negative fails the whole batch insert.
    expect(clampDwell(-5_000, 120_000)).toBe(0);
  });

  it('caps at the platform ceiling — a tab left open overnight is not a nine-hour read', () => {
    expect(clampDwell(9 * 60 * 60 * 1000, 120_000)).toBe(120_000);
  });

  it('passes an ordinary duration through, rounded to a whole millisecond', () => {
    expect(clampDwell(4_321.7, 120_000)).toBe(4_322);
  });

  it('returns null for anything that is not a finite number', () => {
    expect(clampDwell(undefined, 120_000)).toBeNull();
    expect(clampDwell(Number.NaN, 120_000)).toBeNull();
    expect(clampDwell(Number.POSITIVE_INFINITY, 120_000)).toBeNull();
  });

  it('falls back to the schema default rather than to "no clamp" when the ceiling is unusable', () => {
    // An unreachable settings table is the worst moment to stop clamping.
    expect(clampDwell(9_999_999, 0)).toBe(120_000);
    expect(clampDwell(9_999_999, Number.NaN)).toBe(120_000);
  });
});

describe('event normalisation', () => {
  it('keeps dwell only on a section_view', () => {
    expect(normaliseEvent({ kind: 'page_view', path: '/', dwellMs: 5_000 }, 120_000).dwellMs).toBeNull();
    expect(
      normaliseEvent({ kind: 'section_view', path: '/', target: 'about', dwellMs: 5_000 }, 120_000)
        .dwellMs,
    ).toBe(5_000);
  });

  it('drops a section target that is not an anchor, and keeps the event kind honest', () => {
    const event = normaliseEvent({ kind: 'section_view', path: '/', target: 'nope' }, 120_000);
    expect(event.target).toBeNull();
  });

  it('accepts a product slug for a product_view and refuses anything that is not one', () => {
    expect(normaliseEvent({ kind: 'product_view', path: '/', target: 'fustan-1' }, 120_000).target).toBe(
      'fustan-1',
    );
    expect(
      normaliseEvent({ kind: 'product_view', path: '/', target: '../../etc/passwd' }, 120_000).target,
    ).toBeNull();
  });

  it('ignores a target on a kind that has no meaningful one', () => {
    expect(
      normaliseEvent({ kind: 'whatsapp_click', path: '/', target: 'about' }, 120_000).target,
    ).toBeNull();
  });

  it('normalises the search term the same way the search does, so the report groups correctly', () => {
    const event = normaliseEvent(
      { kind: 'search', path: '/search', searchTerm: '  الفستان الأسود ' },
      120_000,
    );
    expect(event.searchTerm).toBe('فستان اسود');
  });

  it('caps the search term, because the rollup groups by that column', () => {
    const event = normaliseEvent(
      { kind: 'search', path: '/search', searchTerm: 'ب'.repeat(500) },
      120_000,
    );
    expect(event.searchTerm?.length).toBeLessThanOrEqual(MAX_SEARCH_TERM_LENGTH);
  });

  it('keeps a result count only on a search', () => {
    expect(
      normaliseEvent({ kind: 'search', path: '/search', searchTerm: 'فستان', resultCount: 0 }, 120_000)
        .resultCount,
    ).toBe(0);
    expect(
      normaliseEvent({ kind: 'page_view', path: '/', resultCount: 99 }, 120_000).resultCount,
    ).toBeNull();
  });
});

describe('the wire format', () => {
  it('refuses an unknown kind — that must be a 400, never a new row in a report', () => {
    const parsed = beaconBodySchema.safeParse({ events: [{ kind: 'rage_click', path: '/' }] });
    expect(parsed.success).toBe(false);
  });

  it('refuses an empty batch and an over-long one', () => {
    expect(beaconBodySchema.safeParse({ events: [] }).success).toBe(false);
    const tooMany = Array.from({ length: MAX_EVENTS_PER_BEACON + 1 }, () => ({
      kind: 'page_view' as const,
      path: '/',
    }));
    expect(beaconBodySchema.safeParse({ events: tooMany }).success).toBe(false);
  });

  it('accepts a realistic batch: a page view plus a few section dwells', () => {
    const parsed = beaconBodySchema.safeParse({
      events: [
        { kind: 'page_view', path: '/' },
        { kind: 'section_view', path: '/', target: 'products', dwellMs: 4_200 },
        { kind: 'whatsapp_click', path: '/' },
      ],
    });
    expect(parsed.success).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// The rollup's arithmetic, against a recording fake
// -----------------------------------------------------------------------------

interface Upsert {
  table: 'analyticsDaily' | 'sectionDwellDaily' | 'searchQueryDaily';
  where: unknown;
  create: Record<string, unknown>;
  update: Record<string, unknown>;
}

/**
 * A `TenantTx` that returns canned aggregate rows and records what was written.
 *
 * The real aggregation is a Postgres concern and is tested against Postgres. What is tested here is
 * the code that sits either side of it: the clamps, the saturation, the reserved row, and the refusal
 * to zero a pruned day. Those are the parts a wrong number would come from.
 */
function fakeTx(rows: {
  paths?: unknown[];
  sections?: unknown[];
  terms?: unknown[];
  siteVisitors?: number;
}): { tx: TenantTx; upserts: Upsert[] } {
  const upserts: Upsert[] = [];
  // Query order in `rollupTenantDay`: paths, sections, terms, then the site total.
  const queue: unknown[][] = [
    rows.paths ?? [],
    rows.sections ?? [],
    rows.terms ?? [],
    [{ visitors: rows.siteVisitors ?? 0 }],
  ];
  let call = 0;

  const model = (table: Upsert['table']) => ({
    upsert: (args: Omit<Upsert, 'table'>) => {
      upserts.push({ ...args, table });
      return Promise.resolve({});
    },
  });

  const tx = {
    $queryRaw: () => Promise.resolve(queue[call++] ?? []),
    analyticsDaily: model('analyticsDaily'),
    sectionDwellDaily: model('sectionDwellDaily'),
    searchQueryDaily: model('searchQueryDaily'),
  } as unknown as TenantTx;

  return { tx, upserts };
}

const PATH_ROW = {
  path: '/',
  visitors: 3,
  pageviews: 5,
  product_views: 0,
  whatsapp_clicks: 1,
  add_to_carts: 0,
  checkout_starts: 0,
  orders: 0,
};

describe('the rollup', () => {
  it('writes NOTHING for a day with no raw rows, rather than writing zeros', async () => {
    // The guard that protects a pruned day. The rollups are the only surviving record; a job that
    // can silently erase them is worse than a job that does nothing.
    const { tx, upserts } = fakeTx({ paths: [] });
    const counts = await rollupTenantDay(tx, 'tenant-1', A_DAY);
    expect(upserts).toEqual([]);
    expect(counts).toEqual({ paths: 0, sections: 0, terms: 0, events: 0 });
  });

  it('writes the day-level distinct visitors to the reserved row, with every other counter zero', async () => {
    const { tx, upserts } = fakeTx({ paths: [PATH_ROW], siteVisitors: 4 });
    await rollupTenantDay(tx, 'tenant-1', A_DAY);

    const site = upserts.find(
      (row) => row.table === 'analyticsDaily' && row.create.path === SITE_TOTAL_PATH,
    );
    expect(site?.create).toMatchObject({ path: SITE_TOTAL_PATH, visitors: 4 });
    // Deliberately absent: SUM(pageviews) over the table has to stay correct for whoever writes the
    // next query against it without knowing this row exists.
    expect(site?.create.pageviews).toBeUndefined();
    expect(site?.update).toEqual({ visitors: 4 });
  });

  it('is idempotent: every update SETs, so a re-run cannot double a count', async () => {
    const { tx, upserts } = fakeTx({
      paths: [PATH_ROW],
      sections: [{ section: 'about', views: 2, total_dwell_ms: 8_000n }],
      terms: [{ term: 'فستان', searches: 3, zero_results: 1 }],
      siteVisitors: 3,
    });
    await rollupTenantDay(tx, 'tenant-1', A_DAY);

    for (const upsert of upserts) {
      for (const value of Object.values(upsert.update)) {
        // An `{ increment: n }` here would make a second run of the same day double the day.
        expect(typeof value).toBe('number');
      }
    }
  });

  it('saturates a dwell sum at the Int column ceiling instead of aborting the transaction', async () => {
    const { tx, upserts } = fakeTx({
      paths: [PATH_ROW],
      sections: [{ section: 'about', views: 40_000, total_dwell_ms: 4_800_000_000n }],
      siteVisitors: 1,
    });
    await rollupTenantDay(tx, 'tenant-1', A_DAY);

    const section = upserts.find((row) => row.table === 'sectionDwellDaily');
    expect(section?.update).toEqual({ views: 40_000, totalDwellMs: 2_147_483_647 });
  });

  it('keeps zero_results <= searches, which is a database CHECK', async () => {
    // A violation means the two numbers came from different reads — the bug the constraint exists to
    // catch. Clamping means a slightly wrong number instead of the whole night's rollup rolling back.
    const { tx, upserts } = fakeTx({
      paths: [PATH_ROW],
      terms: [{ term: 'شنطة', searches: 2, zero_results: 5 }],
      siteVisitors: 1,
    });
    await rollupTenantDay(tx, 'tenant-1', A_DAY);

    const term = upserts.find((row) => row.table === 'searchQueryDaily');
    expect(term?.update).toEqual({ searches: 2, zeroResults: 2 });
  });

  it('groups on a UTC midnight, so the day key matches the visitor-key salt', () => {
    expect(utcDay(new Date('2026-08-14T22:30:00.000Z')).toISOString()).toBe(
      '2026-08-14T00:00:00.000Z',
    );
  });
});

// -----------------------------------------------------------------------------
// The report's four states
// -----------------------------------------------------------------------------

/** A `ScopedDb` that answers the five reads `loadInsights` makes, and nothing else. */
function fakeDb(answers: {
  byDay?: unknown[];
  siteRows?: unknown[];
  pages?: unknown[];
  sections?: unknown[];
  terms?: unknown[];
  zeroTerms?: unknown[];
  consented?: boolean;
  throws?: boolean;
}): ScopedDb {
  const analyticsDaily = {
    // Two groupBy calls with different `by`: the daily series and the top-pages list.
    groupBy: (args: { by: string[] }) =>
      Promise.resolve(args.by[0] === 'day' ? (answers.byDay ?? []) : (answers.pages ?? [])),
    findMany: () => Promise.resolve(answers.siteRows ?? []),
  };

  return {
    analyticsDaily: answers.throws
      ? { groupBy: () => Promise.reject(new Error('timeout')), findMany: () => Promise.resolve([]) }
      : analyticsDaily,
    sectionDwellDaily: { groupBy: () => Promise.resolve(answers.sections ?? []) },
    searchQueryDaily: {
      groupBy: (args: { where?: { zeroResults?: unknown } }) =>
        Promise.resolve(
          args.where?.zeroResults ? (answers.zeroTerms ?? []) : (answers.terms ?? []),
        ),
    },
    consent: {
      findFirst: () => Promise.resolve(answers.consented ? { id: 'consent-1' } : null),
    },
  } as unknown as ScopedDb;
}

describe('the merchant report', () => {
  it('says "waiting for consent" when nobody has ever agreed', async () => {
    // Not «ما في بيانات». Nothing has ever been measurable, and only one of those two sentences
    // tells the merchant why.
    const view = await loadInsights(fakeDb({ consented: false }), 'tenant-1', { now: A_DAY });
    expect(view.state).toBe('awaiting_consent');
    expect(view.totals.pageviews).toBe(0);
  });

  it('says "waiting for the nightly rollup" when consent exists but no day is aggregated yet', async () => {
    const view = await loadInsights(fakeDb({ consented: true }), 'tenant-1', { now: A_DAY });
    expect(view.state).toBe('awaiting_rollup');
  });

  it('says "unavailable" when the read failed, and never renders zeros as if they were data', async () => {
    const view = await loadInsights(fakeDb({ throws: true }), 'tenant-1', { now: A_DAY });
    expect(view.state).toBe('unavailable');
  });

  it('reads visitors from the reserved row and views from the real paths', async () => {
    const view = await loadInsights(
      fakeDb({
        byDay: [
          {
            day: new Date('2026-08-14T00:00:00.000Z'),
            _sum: {
              pageviews: 12,
              productViews: 3,
              whatsappClicks: 2,
              addToCarts: 1,
              checkoutStarts: 1,
              orders: 1,
            },
          },
        ],
        siteRows: [{ day: new Date('2026-08-14T00:00:00.000Z'), visitors: 7 }],
        pages: [{ path: '/', _sum: { pageviews: 12 } }],
      }),
      'tenant-1',
      { now: A_DAY },
    );

    expect(view.state).toBe('ready');
    expect(view.totals.pageviews).toBe(12);
    // Sum of daily uniques — the only multi-day figure a date-salted key can produce.
    expect(view.totals.visitorDays).toBe(7);
    expect(view.series).toEqual([{ day: '2026-08-14', visitors: 7, pageviews: 12 }]);
    expect(view.topPages).toEqual([{ path: '/', pageviews: 12 }]);
  });

  it('divides dwell at read time rather than trusting a stored average', async () => {
    const view = await loadInsights(
      fakeDb({
        byDay: [{ day: new Date('2026-08-14T00:00:00.000Z'), _sum: { pageviews: 1 } }],
        siteRows: [{ day: new Date('2026-08-14T00:00:00.000Z'), visitors: 1 }],
        sections: [{ section: 'about', _sum: { views: 4, totalDwellMs: 10_000 } }],
      }),
      'tenant-1',
      { now: A_DAY },
    );

    expect(view.sections).toEqual([
      { section: 'about', views: 4, totalDwellMs: 10_000, averageDwellMs: 2_500 },
    ]);
  });

  it('never lets a section with no views produce NaN on the merchant’s screen', async () => {
    const view = await loadInsights(
      fakeDb({
        byDay: [{ day: new Date('2026-08-14T00:00:00.000Z'), _sum: { pageviews: 1 } }],
        siteRows: [],
        sections: [{ section: 'about', _sum: { views: 0, totalDwellMs: 0 } }],
      }),
      'tenant-1',
      { now: A_DAY },
    );
    expect(view.sections[0]?.averageDwellMs).toBe(0);
  });

  it('clamps zeroResults to searches on the way out too', async () => {
    const view = await loadInsights(
      fakeDb({
        byDay: [{ day: new Date('2026-08-14T00:00:00.000Z'), _sum: { pageviews: 1 } }],
        siteRows: [],
        zeroTerms: [{ term: 'شنطة', _sum: { searches: 2, zeroResults: 9 } }],
      }),
      'tenant-1',
      { now: A_DAY },
    );
    expect(view.zeroResultTerms).toEqual([{ term: 'شنطة', searches: 2, zeroResults: 2 }]);
  });
});
