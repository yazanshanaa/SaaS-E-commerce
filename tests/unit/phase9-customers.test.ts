import { describe, expect, it } from 'vitest';
import type { TenantTx } from '@/server/db';
import {
  foldOrdersIntoTotals,
  normalisePhone,
  orderCountsTowardSpend,
  phoneDisplay,
  phoneSearchFragment,
  upsertCustomerFromOrder,
  type OrderFacts,
} from '@/server/customers';
import { CART_ORDER_STATUSES, ORDER_STATUSES } from '@/server/orders';
import {
  KPI_MONTH_DAYS,
  KPI_WEEK_DAYS,
  jerusalemDayStart,
  jerusalemDayStartBefore,
  kpiWindows,
} from '@/app/dashboard/_lib/overview';

/**
 * Phase 9 Track E, the parts a unit test can actually prove.
 *
 * Four rules live here, and every one of them is a bug a merchant would notice:
 *
 *   1. two spellings of one phone number are one customer — the whole point of the identity column;
 *   2. a cancelled or refunded order does not inflate what a customer has spent;
 *   3. `marketingConsent` is never set as a side effect of an order — asserted against a recording
 *      fake rather than by reading the code, so a later refactor that adds the field to the write
 *      fails here instead of in production;
 *   4. «مبيعات اليوم» starts at midnight in Asia/Jerusalem, including on the two days a year when
 *      that is not a fixed number of hours from the previous midnight.
 *
 * The database halves — the unique index actually collapsing two spellings, and RLS — are in
 * `tests/integration/phase9-customers.test.ts`, where there is a real PostgreSQL to prove them with.
 */

// -----------------------------------------------------------------------------
// 1. One number, one spelling
// -----------------------------------------------------------------------------

describe('normalisePhone', () => {
  const CANONICAL = '972501112233';

  it('collapses every way a customer writes one mobile number', () => {
    // The five spellings this platform will actually receive: a local number with dashes, an
    // international one with spaces, the `00` prefix an older phone book uses, the bare local form,
    // and a fully hyphenated international one.
    expect(normalisePhone('050-111-2233')).toBe(CANONICAL);
    expect(normalisePhone('+972 50 111 2233')).toBe(CANONICAL);
    expect(normalisePhone('00972501112233')).toBe(CANONICAL);
    expect(normalisePhone('0501112233')).toBe(CANONICAL);
    expect(normalisePhone('972-50-111-22-33')).toBe(CANONICAL);
    // And the shapes a browser autofill or a paste produces.
    expect(normalisePhone('(050) 111 2233')).toBe(CANONICAL);
    expect(normalisePhone('  0501112233  ')).toBe(CANONICAL);
    expect(normalisePhone('501112233')).toBe(CANONICAL);
  });

  it('reads Arabic-Indic digits, because that is what an Arabic keypad produces', () => {
    // Without this, a customer who typed their number on an Arabic keyboard gets a `Customer` row of
    // their own forever, and nothing on any screen explains why there are two of them.
    expect(normalisePhone('٠٥٠١١١٢٢٣٣')).toBe(CANONICAL);
    expect(normalisePhone('۰۵۰-۱۱۱-۲۲۳۳')).toBe(CANONICAL);
  });

  it('keeps a landline, with or without its trunk zero', () => {
    // `04-622-1234` — eight national digits, and the same number typed without the leading zero.
    expect(normalisePhone('04-622-1234')).toBe('97246221234');
    expect(normalisePhone('46221234')).toBe('97246221234');
  });

  /**
   * The fall-through case, and the reason `normalisePhone` does not `return null` the moment a country
   * code matches. `09-721-1223` is a Sharon landline; typed without its trunk zero it is `97211223`,
   * which begins with `972`. Reading that prefix as a country code leaves `11223`, which is nothing.
   */
  it('does not mistake a national number that happens to begin with 972 for a country code', () => {
    expect(normalisePhone('097211223')).toBe('97297211223');
    expect(normalisePhone('97211223')).toBe('97297211223');
  });

  /**
   * `970` stays `970`. See `identity.ts`: the two codes share a numbering plan for mobiles, so folding
   * them would merge more customers correctly than it splits — but `+970 2` is Ramallah and `+972 2`
   * is Jerusalem, and merging two different people into one row (one notes field, one marketing
   * consent) is a worse failure than splitting one customer across two.
   */
  it('keeps a Palestinian country code distinct from the Israeli one', () => {
    expect(normalisePhone('+970 59 111 2233')).toBe('970591112233');
    expect(normalisePhone('00970591112233')).toBe('970591112233');
    // …and a bare local `059` still resolves to the platform's own code.
    expect(normalisePhone('059-111-2233')).toBe('972591112233');
  });

  it('refuses anything it cannot resolve, rather than storing half of it', () => {
    // The failure this signature exists to prevent: a half-normalised string sitting in a unique
    // index next to the row it should have been.
    for (const junk of [
      '',
      '   ',
      'اتصل فيي',
      'phone',
      '+972',
      '972',
      '0',
      '0000',
      '1700700700',
      '*2323',
      '0501112233 or 0521234567',
      '+972-50-111-2233 ext 4',
      '9725011122',
      '05011122334455667788990',
    ]) {
      expect(normalisePhone(junk), junk).toBeNull();
    }
    expect(normalisePhone(null)).toBeNull();
    expect(normalisePhone(undefined)).toBeNull();
  });

  it('is idempotent — its own output normalises to itself', () => {
    // The property every caller relies on: `customerPhoneById` re-normalises before handing a value
    // on, and a rule that changed the answer on a second pass would silently split a customer in two.
    for (const raw of ['050-111-2233', '+970 59 111 2233', '04-622-1234']) {
      const once = normalisePhone(raw)!;
      expect(normalisePhone(once)).toBe(once);
    }
  });
});

describe('phoneSearchFragment', () => {
  it('turns every spelling a merchant might type into the same national digits', () => {
    // This is the other half of the identity rule: «050-111-2233» has to find `972501112233`, and a
    // `contains` on the raw term finds nothing at all.
    for (const typed of ['050-111-2233', '0501112233', '+972 50 111 2233', '00972501112233', '501112233']) {
      expect(phoneSearchFragment(typed), typed).toBe('501112233');
    }
  });

  it('drops the country code so a 972 search finds a 970 customer', () => {
    const fragment = phoneSearchFragment('+972 59 111 2233')!;
    expect('970591112233').toContain(fragment);
    expect('972591112233').toContain(fragment);
  });

  it('matches a partial number typed from the front', () => {
    expect(phoneSearchFragment('050-111')).toBe('50111');
    expect('972501112233').toContain(phoneSearchFragment('050-111')!);
  });

  it('refuses fewer than three digits, because a one-digit contains is not a filter', () => {
    expect(phoneSearchFragment('0')).toBeNull();
    expect(phoneSearchFragment('05')).toBeNull();
    expect(phoneSearchFragment('سارة')).toBeNull();
  });
});

describe('phoneDisplay', () => {
  it('groups a canonical number for someone about to dial it', () => {
    expect(phoneDisplay('972501112233')).toBe('+972 50 111 2233');
    expect(phoneDisplay('970591112233')).toBe('+970 59 111 2233');
    expect(phoneDisplay('97246221234')).toBe('+972 4 622 1234');
  });

  it('prints an unexpected shape rather than hiding it', () => {
    // A row that somehow holds something else should be visible on the screen, not silently blank.
    expect(phoneDisplay('12345')).toBe('+12345');
  });
});

// -----------------------------------------------------------------------------
// 2. What counts as money spent
// -----------------------------------------------------------------------------

describe('the spend rule', () => {
  it('excludes exactly cancelled and refunded, across BOTH status vocabularies', () => {
    const all = [...new Set([...ORDER_STATUSES, ...CART_ORDER_STATUSES])];
    const excluded = all.filter((status) => !orderCountsTowardSpend(status)).sort();
    expect(excluded).toEqual(['cancelled', 'refunded']);
  });

  /**
   * The trap named in `derive.ts`: `isSettledStatus()` is buy_now-only, so using it here would report
   * ₪0 lifetime spend for every cart customer on the platform. This asserts the opposite — that the
   * cart vocabulary's whole happy path counts.
   */
  it('counts every cart status except cancelled, including the ones nobody has paid for yet', () => {
    expect(orderCountsTowardSpend('new')).toBe(true);
    expect(orderCountsTowardSpend('confirmed')).toBe(true);
    expect(orderCountsTowardSpend('preparing')).toBe(true);
    expect(orderCountsTowardSpend('delivered')).toBe(true);
    expect(orderCountsTowardSpend('cancelled')).toBe(false);
  });

  it('counts a buy_now order from the moment it is placed, and drops it if it is refunded', () => {
    expect(orderCountsTowardSpend('pending')).toBe(true);
    expect(orderCountsTowardSpend('paid')).toBe(true);
    expect(orderCountsTowardSpend('fulfilled')).toBe(true);
    // Diverges from `isSettledStatus`, deliberately: money DID arrive, and it went back. That is
    // turnover, not what this customer has spent.
    expect(orderCountsTowardSpend('refunded')).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// 3. The fold — and the two write paths agreeing
// -----------------------------------------------------------------------------

function order(overrides: Partial<OrderFacts> = {}): OrderFacts {
  return {
    customerPhone: '0501112233',
    customerName: 'سارة',
    deliveryArea: 'برطعة',
    status: 'new',
    totalAgorot: 9_900,
    placedAt: new Date('2026-08-01T09:00:00Z'),
    ...overrides,
  };
}

describe('foldOrdersIntoTotals', () => {
  it('counts every order and sums only the ones that are money', () => {
    const totals = foldOrdersIntoTotals('972501112233', [
      order({ totalAgorot: 10_000, placedAt: new Date('2026-08-01T09:00:00Z') }),
      order({ totalAgorot: 5_000, status: 'cancelled', placedAt: new Date('2026-08-02T09:00:00Z') }),
      order({ totalAgorot: 2_500, status: 'delivered', placedAt: new Date('2026-08-03T09:00:00Z') }),
    ]);

    // Three orders, two of them money — «3 طلبات · 125 ₪», which is the pairing a merchant reads.
    expect(totals.ordersCount).toBe(3);
    expect(totals.totalSpentAgorot).toBe(12_500);
  });

  it('never lets a refund pull the total down', () => {
    const totals = foldOrdersIntoTotals('972501112233', [
      order({ totalAgorot: 10_000, status: 'refunded' }),
    ]);
    // Zero, not minus ten thousand — and the database CHECK on `total_spent_agorot >= 0` agrees.
    expect(totals.totalSpentAgorot).toBe(0);
    expect(totals.ordersCount).toBe(1);
  });

  it('finds the first and last order regardless of the order it is handed them in', () => {
    const totals = foldOrdersIntoTotals('972501112233', [
      order({ placedAt: new Date('2026-08-10T09:00:00Z') }),
      order({ placedAt: new Date('2026-07-01T09:00:00Z') }),
      order({ placedAt: new Date('2026-08-03T09:00:00Z') }),
    ]);

    expect(totals.firstOrderAt?.toISOString()).toBe('2026-07-01T09:00:00.000Z');
    expect(totals.lastOrderAt?.toISOString()).toBe('2026-08-10T09:00:00.000Z');
  });

  it('takes the area from the NEWEST order — a customer who moved has one area, not two', () => {
    const totals = foldOrdersIntoTotals('972501112233', [
      order({ deliveryArea: 'برطعة', placedAt: new Date('2026-07-01T09:00:00Z') }),
      order({ deliveryArea: 'يعبد', placedAt: new Date('2026-08-01T09:00:00Z') }),
    ]);
    expect(totals.area).toBe('يعبد');
  });

  it('lets an older order supply a field the newest one left blank', () => {
    // A pickup order carries no delivery area; the customer still lives where they had it delivered.
    const totals = foldOrdersIntoTotals('972501112233', [
      order({ deliveryArea: 'برطعة', placedAt: new Date('2026-07-01T09:00:00Z') }),
      order({ deliveryArea: null, customerName: '  ', placedAt: new Date('2026-08-01T09:00:00Z') }),
    ]);
    expect(totals.area).toBe('برطعة');
    // Whitespace is absence, not a name.
    expect(totals.name).toBe('سارة');
  });

  it('describes a customer with no orders as zeros and no dates, never as a negative', () => {
    const totals = foldOrdersIntoTotals('972501112233', []);
    expect(totals).toEqual({
      phone: '972501112233',
      ordersCount: 0,
      totalSpentAgorot: 0,
      firstOrderAt: null,
      lastOrderAt: null,
      name: null,
      area: null,
    });
  });
});

// -----------------------------------------------------------------------------
// 4. The incremental path, against a recording fake
// -----------------------------------------------------------------------------

interface RecordedCall {
  op: string;
  args: Record<string, unknown>;
}

/**
 * A `TenantTx` that records instead of writing.
 *
 * Only the two operations `upsertCustomerFromOrder` is allowed to perform are implemented, which is
 * itself part of the test: a future version that reaches for `findFirst` or `create` — the read-then-
 * write shape that loses a customer's ORDER to a unique violation — throws here rather than passing.
 *
 * `insertedCount` is what `createMany({ skipDuplicates: true })` returns: 1 when the row was new, 0
 * when `ON CONFLICT DO NOTHING` found one already there.
 */
function recordingTx(insertedCount: number): { tx: TenantTx; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fake = {
    customer: {
      createMany: async (args: Record<string, unknown>) => {
        calls.push({ op: 'createMany', args });
        return { count: insertedCount };
      },
      updateMany: async (args: Record<string, unknown>) => {
        calls.push({ op: 'updateMany', args });
        return { count: 1 };
      },
    },
  };
  return { tx: fake as unknown as TenantTx, calls };
}

/** Every property name anywhere inside a recorded payload — so an assertion about a field can be
 *  made without knowing which nesting level a future refactor puts it at. */
function keysDeep(value: unknown, out: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) keysDeep(item, out);
  } else if (value !== null && typeof value === 'object') {
    for (const [key, nested] of Object.entries(value)) {
      out.add(key);
      keysDeep(nested, out);
    }
  }
  return out;
}

describe('upsertCustomerFromOrder', () => {
  it('ensures the row without a read, then applies the order as an increment', async () => {
    const { tx, calls } = recordingTx(1);
    const result = await upsertCustomerFromOrder(tx, 'tenant-a', order({ totalAgorot: 9_900 }));

    expect(result).toEqual({ ok: true, phone: '972501112233', created: true });
    expect(calls.map((call) => call.op)).toEqual(['createMany', 'updateMany']);

    // `ON CONFLICT DO NOTHING` — the statement that cannot raise, and therefore cannot poison the
    // order transaction it is running inside.
    expect(calls[0]!.args.skipDuplicates).toBe(true);

    const data = calls[1]!.args.data as Record<string, unknown>;
    expect(data.ordersCount).toEqual({ increment: 1 });
    expect(data.totalSpentAgorot).toEqual({ increment: 9_900 });
    expect(data.lastOrderAt).toEqual(new Date('2026-08-01T09:00:00Z'));
  });

  it('reports `created: false` when the row was already there', async () => {
    const { tx } = recordingTx(0);
    const result = await upsertCustomerFromOrder(tx, 'tenant-a', order());
    expect(result).toEqual({ ok: true, phone: '972501112233', created: false });
  });

  it('scopes both statements to the tenant', async () => {
    const { tx, calls } = recordingTx(1);
    await upsertCustomerFromOrder(tx, 'tenant-a', order());

    const created = (calls[0]!.args.data as Array<Record<string, unknown>>)[0]!;
    expect(created.tenantId).toBe('tenant-a');
    expect(calls[1]!.args.where).toEqual({ tenantId: 'tenant-a', phone: '972501112233' });
  });

  /**
   * THE RULE THIS FILE EXISTS FOR.
   *
   * A customer who bought something has not agreed to be marketed to. Asserted against the recorded
   * payloads rather than by reading the source, so the day somebody adds a tick box to the checkout
   * form and wires it through here, this test fails instead of the platform retroactively opting in
   * every customer who ever ordered — with no timestamp and no record of having agreed.
   */
  it('never writes marketingConsent, in either statement, in any nesting', async () => {
    for (const inserted of [0, 1]) {
      const { tx, calls } = recordingTx(inserted);
      await upsertCustomerFromOrder(tx, 'tenant-a', order());

      const written = keysDeep(calls.map((call) => call.args));
      expect(written.has('marketingConsent')).toBe(false);
      expect(written.has('marketingConsentAt')).toBe(false);
      // And it does not touch the merchant's own notes either.
      expect(written.has('notes')).toBe(false);
    }
  });

  it('adds nothing to the spend for a cancelled order, but still counts it', async () => {
    const { tx, calls } = recordingTx(0);
    await upsertCustomerFromOrder(tx, 'tenant-a', order({ status: 'cancelled', totalAgorot: 5_000 }));

    const data = calls[1]!.args.data as Record<string, unknown>;
    expect(data.totalSpentAgorot).toEqual({ increment: 0 });
    expect(data.ordersCount).toEqual({ increment: 1 });
  });

  it('does not blank a name or an area that this order simply did not carry', async () => {
    const { tx, calls } = recordingTx(0);
    await upsertCustomerFromOrder(
      tx,
      'tenant-a',
      order({ customerName: '   ', deliveryArea: null }),
    );

    const data = calls[1]!.args.data as Record<string, unknown>;
    // Absent keys, not nulls: a pickup order must not erase the area a delivery order established.
    expect('name' in data).toBe(false);
    expect('area' in data).toBe(false);
  });

  it('writes nothing at all for an order whose phone cannot be resolved', async () => {
    const { tx, calls } = recordingTx(1);
    const result = await upsertCustomerFromOrder(tx, 'tenant-a', order({ customerPhone: 'اتصل فيي' }));

    // NOT an error: an order must never fail because a phone number was odd. The CRM is a
    // convenience over the orders, not a gate in front of them.
    expect(result).toEqual({ ok: false, reason: 'unusable_phone' });
    expect(calls).toEqual([]);
  });

  it('agrees with the rebuild: three increments land where one fold would', async () => {
    // The property the whole cache rests on. The incremental path and `foldOrdersIntoTotals` are
    // separate implementations of one rule, and this is what keeps them one rule.
    const orders = [
      order({ totalAgorot: 10_000, placedAt: new Date('2026-08-01T09:00:00Z') }),
      order({ totalAgorot: 5_000, status: 'cancelled', placedAt: new Date('2026-08-02T09:00:00Z') }),
      order({ totalAgorot: 2_500, status: 'delivered', placedAt: new Date('2026-08-03T09:00:00Z') }),
    ];

    let ordersCount = 0;
    let spent = 0;
    for (const each of orders) {
      const { tx, calls } = recordingTx(0);
      await upsertCustomerFromOrder(tx, 'tenant-a', each);
      const data = calls[1]!.args.data as Record<string, { increment: number }>;
      ordersCount += data.ordersCount!.increment;
      spent += data.totalSpentAgorot!.increment;
    }

    const rebuilt = foldOrdersIntoTotals('972501112233', orders);
    expect(ordersCount).toBe(rebuilt.ordersCount);
    expect(spent).toBe(rebuilt.totalSpentAgorot);
  });
});

// -----------------------------------------------------------------------------
// 5. «مبيعات اليوم» starts at midnight in Bartaa
// -----------------------------------------------------------------------------

describe('the KPI windows', () => {
  /**
   * Asia/Jerusalem is UTC+3 in summer, so the local day starts at 21:00 UTC the day before. An
   * implementation that took `setUTCHours(0,0,0,0)` would start the window three hours early and
   * count every order taken between 21:00 and midnight local on the wrong day — visible only to
   * somebody working late, and wrong by a different amount in winter.
   */
  it('starts today at local midnight, not at UTC midnight', () => {
    expect(jerusalemDayStart(new Date('2026-08-14T05:00:00Z')).toISOString()).toBe(
      '2026-08-13T21:00:00.000Z',
    );
    // 00:30 local on the 14th is still the 14th — the case a UTC boundary gets wrong.
    expect(jerusalemDayStart(new Date('2026-08-13T21:30:00Z')).toISOString()).toBe(
      '2026-08-13T21:00:00.000Z',
    );
    // 23:30 local on the 13th is still the 13th.
    expect(jerusalemDayStart(new Date('2026-08-13T20:30:00Z')).toISOString()).toBe(
      '2026-08-12T21:00:00.000Z',
    );
  });

  it('uses the winter offset in winter', () => {
    // UTC+2 in January: the same wall clock, two hours of difference.
    expect(jerusalemDayStart(new Date('2026-01-15T05:00:00Z')).toISOString()).toBe(
      '2026-01-14T22:00:00.000Z',
    );
  });

  /**
   * THE DST CASE, and the reason `jerusalemDayStartBefore` adds twelve hours before snapping.
   *
   * Israel moves to summer time on Friday 27 March 2026. Stepping back seven exact 24-hour blocks
   * from midnight on 30 March lands at 23:00 on 22 March — one hour short, and one whole DAY early
   * once that instant is snapped to its own local midnight. The correct answer is 23 March.
   */
  it('steps back CALENDAR days across a daylight-saving change', () => {
    expect(jerusalemDayStartBefore(new Date('2026-03-30T10:00:00Z'), 7).toISOString()).toBe(
      '2026-03-22T22:00:00.000Z',
    );
    // The autumn transition goes the other way and is forgiving, but assert it anyway.
    expect(jerusalemDayStartBefore(new Date('2026-11-01T10:00:00Z'), 7).toISOString()).toBe(
      '2026-10-24T21:00:00.000Z',
    );
  });

  it('treats zero days as today', () => {
    const now = new Date('2026-08-14T05:00:00Z');
    expect(jerusalemDayStartBefore(now, 0).toISOString()).toBe(jerusalemDayStart(now).toISOString());
  });

  it('makes the three windows runs of calendar days ending today', () => {
    const now = new Date('2026-08-14T05:00:00Z');
    const windows = kpiWindows(now);

    // «آخر 7 أيام» INCLUDES today, so the window opens six midnights ago — otherwise the tile
    // silently covers eight days and never agrees with the one beside it.
    expect(windows.today.toISOString()).toBe('2026-08-13T21:00:00.000Z');
    expect(windows.week.toISOString()).toBe('2026-08-07T21:00:00.000Z');
    expect(windows.month.toISOString()).toBe('2026-07-15T21:00:00.000Z');

    expect(KPI_WEEK_DAYS).toBe(7);
    expect(KPI_MONTH_DAYS).toBe(30);
    // Nested, not adjacent: today is inside the week is inside the month, which is why the three
    // sums are three aggregates rather than one grouped query.
    expect(windows.month.getTime()).toBeLessThan(windows.week.getTime());
    expect(windows.week.getTime()).toBeLessThan(windows.today.getTime());
  });
});
