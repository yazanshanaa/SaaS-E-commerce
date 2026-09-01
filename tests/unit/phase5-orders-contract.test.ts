import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CART_ORDER_STATUSES,
  ORDER_STATUSES,
  canTransitionOrder,
  isOrderStatus,
  isSettledStatus,
  nextOrderStatuses,
  type OrderStatusValue,
} from '@/server/orders/status';
import {
  CHECKOUT_MAX_QUANTITY,
  checkoutSchema,
  gatewayConfigSchema,
  merchantPaymentsSchema,
  orderStatusChangeSchema,
} from '@/server/orders/schema';

/**
 * The pure half of Phase 5: the order state machine and every input schema.
 *
 * Both are worth testing without a database because both are decisions rather than plumbing — an
 * illegal transition that slips through writes a `Payment` row for money nobody received, and a
 * validation message that is not an i18n key reaches a customer in English.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** `namespace:dotted.key` — the shape `fieldErrorsFromZod` accepts and nothing else. */
const MESSAGE_KEY = /^[a-z]+:[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*$/;

describe('the order state machine', () => {
  it('lets a pending order be paid or cancelled, and nothing else', () => {
    expect(canTransitionOrder('pending', 'paid')).toBe(true);
    expect(canTransitionOrder('pending', 'cancelled')).toBe(true);
    expect(canTransitionOrder('pending', 'fulfilled')).toBe(false);
    expect(canTransitionOrder('pending', 'refunded')).toBe(false);
  });

  it('lets a paid order be fulfilled, refunded or cancelled', () => {
    expect(nextOrderStatuses('paid')).toEqual(['fulfilled', 'refunded', 'cancelled']);
  });

  it('treats cancelled and refunded as terminal, from every direction', () => {
    for (const to of ORDER_STATUSES) {
      expect(canTransitionOrder('cancelled', to), `cancelled -> ${to}`).toBe(false);
      expect(canTransitionOrder('refunded', to), `refunded -> ${to}`).toBe(false);
    }
  });

  it('never allows a return to pending', () => {
    // An order that was paid and then un-paid is a correction, not a state: reversing the flag
    // would silently detach the Payment row recorded against it.
    for (const from of ORDER_STATUSES) {
      if (from === 'pending') continue;
      expect(canTransitionOrder(from, 'pending'), `${from} -> pending`).toBe(false);
    }
  });

  it('counts a refunded order as settled, because the money did arrive', () => {
    expect(isSettledStatus('paid')).toBe(true);
    expect(isSettledStatus('fulfilled')).toBe(true);
    expect(isSettledStatus('refunded')).toBe(true);
    expect(isSettledStatus('pending')).toBe(false);
    expect(isSettledStatus('cancelled')).toBe(false);
  });

  it('rejects a status that is not one of the five', () => {
    expect(isOrderStatus('shipped')).toBe(false);
    expect(isOrderStatus('paid')).toBe(true);
  });

  /**
   * The DRIFT GUARD. `OrderStatus` is a Postgres enum, and the TypeScript lists above are what
   * every screen, filter and transition table are built from. If someone adds a value to the
   * schema and not here, the new state becomes unreachable in the UI and un-transitionable in
   * the service — silently, because nothing else compares the two.
   *
   * Phase 8 split this enum into TWO vocabularies sharing one Postgres type
   * (`Order.channel` tells them apart — see schema.prisma's own comment on `OrderStatus`):
   * `ORDER_STATUSES` (buy_now, unchanged since Phase 5) and `CART_ORDER_STATUSES` (cart, new).
   * The guard now checks the UNION against the enum rather than `ORDER_STATUSES` alone — and
   * separately asserts the two lists share only `cancelled`, so a value accidentally added to
   * both transition tables would still be caught.
   */
  it('matches the Prisma enum exactly', () => {
    const schema = readFileSync(path.join(repoRoot, 'prisma/schema.prisma'), 'utf8');
    const block = /enum OrderStatus \{([\s\S]*?)\n\}/.exec(schema);
    expect(block, 'enum OrderStatus not found in schema.prisma').not.toBeNull();

    const members = block![1]!
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('@@') && !line.startsWith('//'));

    const declared = new Set([...ORDER_STATUSES, ...CART_ORDER_STATUSES]);
    expect(new Set(members)).toEqual(declared);
    expect(members.length).toBe(declared.size);

    const shared = ORDER_STATUSES.filter((status) => (CART_ORDER_STATUSES as readonly string[]).includes(status));
    expect(shared).toEqual(['cancelled']);
  });
});

describe('the checkout schema', () => {
  const valid = {
    productSlug: 'kanafa-tray',
    quantity: 2,
    customerName: 'أحمد عودة',
    customerPhone: '0599123456',
    customerNote: 'بدي أستلمه بعد العصر',
  };

  it('accepts a real order', () => {
    const parsed = checkoutSchema.safeParse(valid);
    expect(parsed.success).toBe(true);
  });

  it('accepts a local number and an international one, and normalises separators', () => {
    // A customer in Bartaa types `059…`; refusing that would lose the order to protect nothing.
    // The merchant's OWN number is held to international form for a different reason entirely.
    for (const [input, expected] of [
      ['0599123456', '0599123456'],
      ['+970 59-912-3456', '+970599123456'],
      ['00972 50 000 0000', '00972500000000'],
    ] as const) {
      const parsed = checkoutSchema.safeParse({ ...valid, customerPhone: input });
      expect(parsed.success, input).toBe(true);
      if (parsed.success) expect(parsed.data.customerPhone).toBe(expected);
    }
  });

  it('refuses a name too short to identify anyone', () => {
    const parsed = checkoutSchema.safeParse({ ...valid, customerName: 'أ' });
    expect(parsed.success).toBe(false);
  });

  it('refuses a phone number that cannot be dialled', () => {
    for (const phone of ['', '123', 'اتصل فيي']) {
      expect(checkoutSchema.safeParse({ ...valid, customerPhone: phone }).success, phone).toBe(false);
    }
  });

  it('bounds the quantity at both ends', () => {
    expect(checkoutSchema.safeParse({ ...valid, quantity: 0 }).success).toBe(false);
    expect(
      checkoutSchema.safeParse({ ...valid, quantity: CHECKOUT_MAX_QUANTITY + 1 }).success,
    ).toBe(false);
    expect(checkoutSchema.safeParse({ ...valid, quantity: CHECKOUT_MAX_QUANTITY }).success).toBe(
      true,
    );
  });

  it('refuses a note long enough to be an essay', () => {
    expect(checkoutSchema.safeParse({ ...valid, customerNote: 'ا'.repeat(2_000) }).success).toBe(
      false,
    );
  });

  it('drops an empty note rather than storing one', () => {
    const parsed = checkoutSchema.safeParse({ ...valid, customerNote: '   ' });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.customerNote).toBeUndefined();
  });

  /**
   * Every message must be an i18n key. Zod's own defaults are English sentences, and an English
   * sentence reaching an Arabic-speaking customer at the moment they are trying to buy something
   * is the single most visible way this rule fails.
   */
  it('produces only i18n keys, never a sentence', () => {
    const parsed = checkoutSchema.safeParse({
      productSlug: '',
      quantity: 0,
      customerName: '',
      customerPhone: '1',
      customerNote: 'ا'.repeat(2_000),
    });

    expect(parsed.success).toBe(false);
    if (parsed.success) return;

    /**
     * EVERY message, not "every message that looks like a key".
     *
     * The looser assertion is the trap itself: zod 4's default for a `min(1)` failure is
     * `Too small: expected string to have >=1 characters`, which contains a colon and therefore
     * passes any "does it look namespaced" heuristic. `src/app/dashboard/_lib/validation.ts`
     * already had to be hardened against exactly that, so this schema names every bound instead of
     * relying on the downstream scrub.
     */
    for (const issue of parsed.error.issues) {
      expect(issue.message, `${issue.path.join('.')}: ${issue.message}`).toMatch(MESSAGE_KEY);
    }
  });

  it('names a message for every field, so no zod default can reach the scrub', () => {
    // Each field failed on a DIFFERENT rule than the case above, to reach the other bounds.
    const parsed = checkoutSchema.safeParse({
      productSlug: 'x'.repeat(200),
      quantity: 5.5,
      customerName: 'ن'.repeat(200),
      customerPhone: '+1',
      customerNote: 'ن'.repeat(600),
    });

    expect(parsed.success).toBe(false);
    if (parsed.success) return;

    for (const issue of parsed.error.issues) {
      expect(issue.message, `${issue.path.join('.')}: ${issue.message}`).toMatch(MESSAGE_KEY);
    }
  });
});

describe('the other Phase 5 schemas', () => {
  it('accepts a legal status change and refuses an unknown status', () => {
    expect(orderStatusChangeSchema.safeParse({ orderId: 'o1', status: 'paid' }).success).toBe(true);
    expect(orderStatusChangeSchema.safeParse({ orderId: 'o1', status: 'shipped' }).success).toBe(
      false,
    );
    expect(orderStatusChangeSchema.safeParse({ orderId: '', status: 'paid' }).success).toBe(false);
  });

  it('refuses an unknown gateway provider', () => {
    expect(gatewayConfigSchema.safeParse({ provider: 'stripe', credentials: {} }).success).toBe(
      false,
    );
    expect(gatewayConfigSchema.safeParse({ provider: 'manual', credentials: {} }).success).toBe(
      true,
    );
  });

  it('lets the merchant switch selling off with no instructions at all', () => {
    const parsed = merchantPaymentsSchema.safeParse({ sellingEnabled: false, instructions: '' });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.instructions).toBeUndefined();
  });
});

describe('the ORDER STATUS labels a merchant reads', () => {
  it('exist in Arabic for every status in the enum', () => {
    const dashboard = JSON.parse(
      readFileSync(path.join(repoRoot, 'messages/ar/dashboard.json'), 'utf8'),
    ) as { orders: { statuses: Record<string, string>; moveTo: Record<string, string> } };

    for (const status of ORDER_STATUSES) {
      expect(dashboard.orders.statuses[status], `no label for ${status}`).toBeTruthy();
    }

    // And a button label for every transition the machine can actually offer.
    const reachable = new Set<OrderStatusValue>();
    for (const from of ORDER_STATUSES) for (const to of nextOrderStatuses(from)) reachable.add(to);
    for (const status of reachable) {
      expect(dashboard.orders.moveTo[status], `no button label for ${status}`).toBeTruthy();
    }
  });
});
