/**
 * `src/server/customers` — Phase 9 / Track E's public surface.
 *
 * Read in this order: `identity.ts` (what makes two spellings one customer, and the file to be most
 * careful with), `derive.ts` (the two write paths and the rule that they must agree), `query.ts`
 * (the merchant's reads, plus the only two writes an order never makes).
 *
 * The whole table is derived from orders. Nothing in this folder collects a customer, and
 * `upsertCustomerFromOrder` is the only thing that creates one out of an order — see its docblock for
 * why `marketingConsent` is absent from it and must stay absent.
 */

export {
  isNormalisedPhone,
  normalisePhone,
  phoneDisplay,
  phoneSearchFragment,
} from './identity';

export {
  foldOrdersIntoTotals,
  orderCountsTowardOrdersCount,
  orderCountsTowardSpend,
  recomputeCustomerTotals,
  scanCustomerOrders,
  upsertCustomerFromOrder,
  type OrderFacts,
  type OrderScanResult,
  type RecomputeResult,
  type UpsertCustomerResult,
} from './derive';

export {
  customerNotesSchema,
  customerPhoneById,
  getCustomer,
  listCustomerOrders,
  listCustomers,
  marketingConsentSchema,
  saveCustomerNotes,
  setMarketingConsent,
  type CustomerNotesInput,
  type ListCustomersOptions,
  type MarketingConsentInput,
} from './query';

export {
  CUSTOMER_ORDER_HISTORY_LIMIT,
  CUSTOMER_PAGE_SIZE,
  MAX_CUSTOMER_NOTES_LENGTH,
  MAX_CUSTOMER_PAGE_SIZE,
  MAX_ORDERS_SCANNED_PER_CUSTOMER,
  ORDER_SCAN_PAGE,
  type CustomerDetail,
  type CustomerListPage,
  type CustomerOrderLine,
  type CustomerOrderRow,
  type CustomerRow,
  type CustomerSort,
  type CustomerTotals,
} from './types';
