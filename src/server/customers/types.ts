import type { OrderChannelValue, OrderStatusValue } from '@/server/orders';

/**
 * The shapes and the bounds. Every limit in the customers surface is declared here rather than in
 * the database, for the reason Track A gave for the variant cap: these are limits on a SCREEN, and a
 * screen's limits change without a migration.
 */

/** «ملاحظات» — a merchant's own note about a customer. Long enough for an address and a preference,
 *  short enough that the field is never mistaken for an order history. */
export const MAX_CUSTOMER_NOTES_LENGTH = 1_000;

export const CUSTOMER_PAGE_SIZE = 25;
export const MAX_CUSTOMER_PAGE_SIZE = 100;

/** Orders shown on one customer's detail screen. More than this is a report, not a profile. */
export const CUSTOMER_ORDER_HISTORY_LIMIT = 20;

/**
 * The ceiling on how many order rows one customer lookup may read.
 *
 * `Order.customerPhone` holds what the customer typed, so matching a canonical phone means
 * normalising each row (see `derive.ts` for why there is no index to use instead). That is a scan,
 * and a scan needs a ceiling — but the ceiling is REPORTED rather than silently applied:
 * `recomputeCustomerTotals` refuses to write a total it could not finish computing, because a cache
 * rebuilt from part of the data is worse than the stale cache it replaced.
 */
export const MAX_ORDERS_SCANNED_PER_CUSTOMER = 20_000;

/** Rows per page of the scan above. Small enough to bound memory, large enough that a shop with a
 *  few hundred orders finishes in one round trip. */
export const ORDER_SCAN_PAGE = 500;

export interface CustomerRow {
  id: string;
  /** Canonical, from `normalisePhone`. Rendered through `phoneDisplay`. */
  phone: string;
  name: string | null;
  /** Last delivery area seen on an order — the reference shop's «المنطقة» column. */
  area: string | null;
  ordersCount: number;
  totalSpentAgorot: number;
  firstOrderAt: Date | null;
  lastOrderAt: Date | null;
  marketingConsent: boolean;
  marketingConsentAt: Date | null;
}

export interface CustomerListPage {
  rows: CustomerRow[];
  /** Cursor rather than offset — customers only ever get added. Null at the end. */
  nextCursor: string | null;
  /** The whole tenant's count, never the page's: a merchant reading "12 customers" off page one of
   *  nine would plan a campaign around it. */
  total: number;
  /** How many of them said yes to marketing. The only number on the list screen that is about
   *  permission rather than about trade. */
  withConsent: number;
}

/** How the list is ordered. Three orderings, all of them indexed
 *  (`@@index([tenantId, lastOrderAt])` and `@@index([tenantId, totalSpentAgorot])`). */
export type CustomerSort = 'recent' | 'spend' | 'orders';

export interface CustomerOrderLine {
  nameSnapshot: string;
  /** «M · وردي», snapshotted on the order item. Null on every pre-variant row and on every product
   *  that has no variant axis. */
  variantLabel: string | null;
  quantity: number;
}

export interface CustomerOrderRow {
  id: string;
  number: number;
  status: OrderStatusValue;
  /** Which status vocabulary `status` belongs to — the two share one Postgres enum and are told
   *  apart by this column alone (src/server/orders/status.ts). */
  channel: OrderChannelValue;
  totalAgorot: number;
  currency: string;
  placedAt: Date;
  deliveryArea: string | null;
  /** Absent on the scan rows; filled only for the orders actually displayed. */
  items?: CustomerOrderLine[];
}

export interface CustomerDetail {
  customer: CustomerRow;
  notes: string | null;
  orders: CustomerOrderRow[];
  /**
   * True when the scan hit `MAX_ORDERS_SCANNED_PER_CUSTOMER` before the end of the tenant's orders,
   * so the history below is the newest part of it and not all of it. Said on the screen rather than
   * left for the merchant to notice that an old order is missing.
   */
  historyTruncated: boolean;
}

/** What a rebuild computes. The same shape the incremental path maintains, which is what makes the
 *  two comparable in a test. */
export interface CustomerTotals {
  phone: string;
  ordersCount: number;
  totalSpentAgorot: number;
  firstOrderAt: Date | null;
  lastOrderAt: Date | null;
  /** From the NEWEST order that carries one — a customer who moved has a new area, not both. */
  name: string | null;
  area: string | null;
}
