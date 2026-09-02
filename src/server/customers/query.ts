import { z } from 'zod';
import type { ScopedDb, TenantTx } from '@/server/db';
import { scanCustomerOrders } from './derive';
import { normalisePhone, phoneSearchFragment } from './identity';
import {
  CUSTOMER_ORDER_HISTORY_LIMIT,
  CUSTOMER_PAGE_SIZE,
  MAX_CUSTOMER_NOTES_LENGTH,
  MAX_CUSTOMER_PAGE_SIZE,
  type CustomerDetail,
  type CustomerListPage,
  type CustomerOrderLine,
  type CustomerOrderRow,
  type CustomerRow,
  type CustomerSort,
} from './types';

/**
 * The merchant's read side — and the only two writes to `customers` that an order did not cause.
 *
 * That split is why the writes live here rather than in `derive.ts`: `notes` and the two consent
 * columns are the merchant's OWN work, not derived from anything, and putting them beside the
 * derivation would invite the next reader to assume an order can set them. It cannot, and
 * `upsertCustomerFromOrder` says so at length.
 */

const CUSTOMER_SELECT = {
  id: true,
  phone: true,
  name: true,
  area: true,
  ordersCount: true,
  totalSpentAgorot: true,
  firstOrderAt: true,
  lastOrderAt: true,
  marketingConsent: true,
  marketingConsentAt: true,
} as const;

export interface ListCustomersOptions {
  /** A name or a phone, as the merchant typed it. */
  search?: string;
  sort?: CustomerSort;
  cursor?: string;
  take?: number;
}

/**
 * The list, searched server-side.
 *
 * SEARCH IS SERVER-SIDE AND NOT A CLIENT FILTER, for the ordinary reason and one specific one: the
 * page is a cursor page, so a client filter would search whatever twenty-five rows happened to be
 * loaded and report «ما في زبون بهذا الاسم» about the other four hundred.
 *
 * THE PHONE HALF SEARCHES THE NORMALISED VALUE. A merchant types «050-111-2233» and the column holds
 * `972501112233`; a `contains` on the raw term matches nothing at all. `phoneSearchFragment` reduces
 * the term to the national digits, which is also what makes a `+972 …` search find a customer stored
 * under `970 …` (see `identity.ts` for why those two codes stay apart).
 *
 * The two halves are an OR, and the name half is `mode: 'insensitive'`. Arabic has no case, so that
 * flag does nothing for «سارة» — it is there for the Latin names a real customer list also contains
 * («Nike», a surname), where a case-sensitive search reads as a broken box.
 *
 * What is NOT attempted: Arabic normalisation of the name (أ/ا, ة/ه, diacritics). Track C's
 * `src/server/search/normalise.ts` does that properly for the storefront, against a bounded product
 * scan; doing it here would mean either scanning every customer in memory or a stored normalised
 * column, and the second is a migration. Recorded in the handoff.
 */
export async function listCustomers(
  db: ScopedDb | TenantTx,
  tenantId: string,
  options: ListCustomersOptions = {},
): Promise<CustomerListPage> {
  const take = Math.min(MAX_CUSTOMER_PAGE_SIZE, Math.max(5, options.take ?? CUSTOMER_PAGE_SIZE));
  const term = options.search?.trim() ?? '';

  const fragment = term === '' ? null : phoneSearchFragment(term);
  const where = {
    tenantId,
    ...(term === ''
      ? {}
      : {
          OR: [
            { name: { contains: term, mode: 'insensitive' as const } },
            ...(fragment ? [{ phone: { contains: fragment } }] : []),
          ],
        }),
  };

  const [rows, total, withConsent] = await Promise.all([
    db.customer.findMany({
      where,
      orderBy: orderFor(options.sort ?? 'recent'),
      take: take + 1,
      ...(options.cursor ? { cursor: { id: options.cursor }, skip: 1 } : {}),
      select: CUSTOMER_SELECT,
    }),
    // Both counters are of the WHOLE list rather than of the page, and both ignore the search term:
    // «120 زبون، 34 منهم موافقين» is a fact about the shop, and recomputing it per search would make
    // it a fact about the search box instead.
    db.customer.count({ where: { tenantId } }),
    db.customer.count({ where: { tenantId, marketingConsent: true } }),
  ]);

  const page = rows.slice(0, take);

  return {
    rows: page.map(toCustomerRow),
    nextCursor: rows.length > take ? (page[page.length - 1]?.id ?? null) : null,
    total,
    withConsent,
  };
}

/**
 * `lastOrderAt` can be null on a row whose orders were all deleted, and Postgres sorts NULLs last on
 * `desc` by default — which is where they belong: a customer with no dated order is not the most
 * recent one. `id` is the tiebreak on every ordering, because a cursor page over a non-unique sort
 * key silently repeats and skips rows.
 */
function orderFor(sort: CustomerSort) {
  switch (sort) {
    case 'spend':
      return [{ totalSpentAgorot: 'desc' as const }, { id: 'desc' as const }];
    case 'orders':
      return [{ ordersCount: 'desc' as const }, { id: 'desc' as const }];
    default:
      return [{ lastOrderAt: 'desc' as const }, { id: 'desc' as const }];
  }
}

function toCustomerRow(row: {
  id: string;
  phone: string;
  name: string | null;
  area: string | null;
  ordersCount: number;
  totalSpentAgorot: number;
  firstOrderAt: Date | null;
  lastOrderAt: Date | null;
  marketingConsent: boolean;
  marketingConsentAt: Date | null;
}): CustomerRow {
  return row;
}

/**
 * One customer, with the orders that produced them.
 *
 * The counts on the row are the CACHE (`ordersCount`, `totalSpentAgorot`); the history below is read
 * fresh. They can disagree — a cancellation that never triggered a recompute is the ordinary case —
 * and the screen shows both rather than hiding one, because that disagreement is exactly the signal
 * that the «أعد الحساب» control exists for.
 */
export async function getCustomer(
  db: ScopedDb | TenantTx,
  tenantId: string,
  customerId: string,
): Promise<CustomerDetail | null> {
  const customer = await db.customer.findFirst({
    where: { id: customerId, tenantId },
    select: { ...CUSTOMER_SELECT, notes: true },
  });
  if (!customer) return null;

  const { notes, ...row } = customer;
  const history = await listCustomerOrders(db, tenantId, row.phone);

  return {
    customer: toCustomerRow(row),
    notes,
    orders: history.rows,
    historyTruncated: history.truncated,
  };
}

/**
 * The newest orders of one customer, with their lines.
 *
 * Two phases on purpose. The scan reads six columns of every order the tenant has (see
 * `scanCustomerOrders` for why it must), so pulling `items` inside it would multiply the widest read
 * on the screen by the size of the catalogue. The lines are fetched for the twenty rows that are
 * actually rendered, in one query, keyed by the ids the scan already resolved.
 */
export async function listCustomerOrders(
  db: ScopedDb | TenantTx,
  tenantId: string,
  phone: string,
  take: number = CUSTOMER_ORDER_HISTORY_LIMIT,
): Promise<{ rows: CustomerOrderRow[]; truncated: boolean }> {
  const scan = await scanCustomerOrders(db, tenantId, phone);
  const shown = scan.rows.slice(0, take);
  if (shown.length === 0) return { rows: shown, truncated: scan.truncated };

  const lines = await db.orderItem.findMany({
    where: { tenantId, orderId: { in: shown.map((row) => row.id) } },
    orderBy: { createdAt: 'asc' },
    select: { orderId: true, nameSnapshot: true, variantLabel: true, quantity: true },
  });

  const byOrder = new Map<string, CustomerOrderLine[]>();
  for (const line of lines) {
    const bucket = byOrder.get(line.orderId) ?? [];
    bucket.push({
      nameSnapshot: line.nameSnapshot,
      // The SNAPSHOT, not a live lookup: a merchant who deleted a discontinued variant must still be
      // able to read what this customer actually bought (OrderItem's own docblock).
      variantLabel: line.variantLabel,
      quantity: line.quantity,
    });
    byOrder.set(line.orderId, bucket);
  }

  return {
    rows: shown.map((row) => ({ ...row, items: byOrder.get(row.id) ?? [] })),
    truncated: scan.truncated || scan.rows.length > take,
  };
}

// -----------------------------------------------------------------------------
// The two writes an order never makes
// -----------------------------------------------------------------------------

/**
 * Invariant 3: every mutation input is zod-validated, and the message is an i18n KEY rather than a
 * sentence — a server module has no business holding Arabic copy, and `fieldErrorsFromZod` replaces
 * anything that is not key-shaped with a generic message, so an English zod default cannot reach a
 * merchant.
 */
export const customerNotesSchema = z.object({
  customerId: z.string().trim().min(1, 'customers:errors.notFound').max(64, 'customers:errors.notFound'),
  notes: z
    .string()
    .trim()
    .max(MAX_CUSTOMER_NOTES_LENGTH, 'customers:errors.notesTooLong')
    // Empty means "no note", stored as NULL rather than as an empty string: two spellings of absence
    // in one column is how a `notes IS NOT NULL` filter starts lying.
    .transform((value) => (value === '' ? null : value)),
});

export const marketingConsentSchema = z.object({
  customerId: z.string().trim().min(1, 'customers:errors.notFound').max(64, 'customers:errors.notFound'),
  granted: z.boolean(),
});

export type CustomerNotesInput = z.infer<typeof customerNotesSchema>;
export type MarketingConsentInput = z.infer<typeof marketingConsentSchema>;

export async function saveCustomerNotes(
  db: ScopedDb | TenantTx,
  tenantId: string,
  input: CustomerNotesInput,
): Promise<boolean> {
  // `updateMany` with the tenant in the `where`, not `update` by id: the scoped client and RLS both
  // block the cross-tenant case, and this makes the miss a `count: 0` to report rather than a thrown
  // P2025 for a route to translate.
  const updated = await db.customer.updateMany({
    where: { id: input.customerId, tenantId },
    data: { notes: input.notes },
  });
  return updated.count === 1;
}

/**
 * «موافقة تسويقية» — the one place this flag is ever set.
 *
 * THE TIMESTAMP IS THE RECORD, not the boolean. `marketingConsentAt` is stamped on the way in and
 * left alone on the way out: a merchant who is asked six months later when a customer agreed needs a
 * date, and clearing it on withdrawal would erase the evidence that the consent was ever lawful.
 * That is the same shape the storefront's own consent records use — a timestamped per-tenant row
 * (docs/PHASE-9.md, compliance defaults) — rather than a bare flag.
 *
 * Withdrawal therefore sets `marketingConsent: false` and keeps the date. The flag is what any
 * campaign must read; the date is only ever evidence.
 */
export async function setMarketingConsent(
  db: ScopedDb | TenantTx,
  tenantId: string,
  input: MarketingConsentInput,
): Promise<boolean> {
  const updated = await db.customer.updateMany({
    where: { id: input.customerId, tenantId },
    data: {
      marketingConsent: input.granted,
      ...(input.granted ? { marketingConsentAt: new Date() } : {}),
    },
  });
  return updated.count === 1;
}

/**
 * The canonical phone behind a customer id, for the callers that hold an id and need the identity —
 * the recompute control on the detail screen, and any future job that fans out per customer.
 */
export async function customerPhoneById(
  db: ScopedDb | TenantTx,
  tenantId: string,
  customerId: string,
): Promise<string | null> {
  const row = await db.customer.findFirst({
    where: { id: customerId, tenantId },
    select: { phone: true },
  });
  // Through `normalisePhone` rather than returned raw: every other reader treats this value as
  // canonical, and a row written before a normalisation rule changed must not be handed on as though
  // it still were.
  return row ? normalisePhone(row.phone) : null;
}
