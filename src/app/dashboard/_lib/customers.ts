import { notFound } from 'next/navigation';
import { roleHasScope } from '@/server/auth';
import {
  customerNotesSchema,
  customerPhoneById,
  getCustomer,
  listCustomers,
  marketingConsentSchema,
  recomputeCustomerTotals,
  saveCustomerNotes,
  setMarketingConsent,
  type CustomerDetail,
  type CustomerListPage,
  type CustomerSort,
} from '@/server/customers';
import { canBool } from '@/server/entitlements';
import { requireMerchantPage } from '../_components/guard';
import { audit } from './audit';
import type { MerchantContext } from './context';
import { failure, invalid, ok, type ActionState } from './validation';

/**
 * «الزبائن» — the merchant side of the derived customers index.
 *
 * BOTH GATES, ASKED EXPLICITLY, AND BOTH REFUSALS ARE A 404.
 *
 *   axis (a)  `can(tenantId, 'customers_crm')` — does this shop have a customers list at all? When it
 *             does not, the screen is ABSENT, not disabled and not an upsell.
 *   the role   OWNER ONLY.
 *
 * WHY OWNER ONLY, when `staff` may process orders. A staff member who fulfils orders sees one
 * customer at a time, in the context of the order they are packing — which is the data they need.
 * This screen is the whole list, sortable by lifetime spend, searchable, and it carries the marketing
 * consent flag: it is a marketing asset, and the person most likely to walk out with a copy of it is
 * a departing employee. Q13's staff list is products + orders + media exhaustively, and «الزبائن»
 * belongs with `settings` and `coupons` on the other side of that line. The reference shop makes the
 * same call.
 *
 * There is no `customers` entry in `MERCHANT_SCOPES` (src/server/auth/rbac.ts is not this track's
 * file), so the role half is asked here through `roleHasScope(ctx.role, 'settings')` — the same
 * two-gate shape `dashboard/insights/page.tsx` and `dashboard/delivery/data.ts` already use, and for
 * the same reason. `docs/PHASE-9-track-e-handoff.md` carries the diff that adds a real scope with
 * `FEATURE_GATED.customers = 'customers_crm'` and collapses all of this to
 * `requireMerchantPage('customers')`.
 *
 * `settings` rather than `analytics` because a refused scope must never be a hint: both are
 * owner-only and either would work, and `settings` is the one whose meaning ("this is the owner's
 * business, not the shop floor") matches what is being protected.
 */

export async function requireCustomersContext(): Promise<MerchantContext> {
  const ctx = await requireMerchantPage();
  if (!roleHasScope(ctx.role, 'settings')) notFound();
  if (!(await canBool(ctx.tenantId, 'customers_crm'))) notFound();
  return ctx;
}

const SORTS: readonly CustomerSort[] = ['recent', 'spend', 'orders'];

/** A `?sort=` value from a URL, or the default. Never trusted as a column name — the three
 *  orderings are a closed set and `listCustomers` maps them to `orderBy` itself. */
export function parseSort(value: string | undefined): CustomerSort {
  return value && (SORTS as readonly string[]).includes(value) ? (value as CustomerSort) : 'recent';
}

export interface CustomersListView {
  page: CustomerListPage;
  search: string | null;
  sort: CustomerSort;
}

export async function loadCustomers(
  ctx: MerchantContext,
  options: { search?: string; sort?: string; cursor?: string } = {},
): Promise<CustomersListView> {
  const search = options.search?.trim() || null;
  const sort = parseSort(options.sort);

  return {
    page: await listCustomers(ctx.db, ctx.tenantId, {
      search: search ?? undefined,
      sort,
      cursor: options.cursor,
    }),
    search,
    sort,
  };
}

export async function loadCustomer(
  ctx: MerchantContext,
  customerId: string,
): Promise<CustomerDetail | null> {
  return getCustomer(ctx.db, ctx.tenantId, customerId);
}

// -----------------------------------------------------------------------------
// Writes
// -----------------------------------------------------------------------------

export async function saveNotesAction(ctx: MerchantContext, raw: unknown): Promise<ActionState> {
  const parsed = customerNotesSchema.safeParse(raw);
  if (!parsed.success) return invalid(parsed.error);

  const saved = await saveCustomerNotes(ctx.db, ctx.tenantId, parsed.data);
  return saved ? ok('customers:detail.notesSaved') : failure('customers:errors.notFound');
}

/**
 * The explicit consent toggle — the only path that sets the flag.
 *
 * AUDITED, unlike the notes field beside it. `_lib/audit.ts` draws the line at "destructive or
 * structural" and deliberately does not write a row per product edit; a consent change is neither
 * frequent nor low-stakes. It decides whether a person may lawfully be contacted, and the support
 * call it answers — «ليش وصلني إعلان؟» — is unanswerable without a row naming who set it, when, and
 * from which address.
 *
 * The customer id is recorded and the PHONE IS NOT (invariant 7: no PII in logs, and an audit row is
 * read by operators). The id resolves to the row for anyone entitled to read it, and resolves to
 * nothing for anyone who is not.
 */
export async function setConsentAction(ctx: MerchantContext, raw: unknown): Promise<ActionState> {
  const parsed = marketingConsentSchema.safeParse(raw);
  if (!parsed.success) return invalid(parsed.error);

  const saved = await setMarketingConsent(ctx.db, ctx.tenantId, parsed.data);
  if (!saved) return failure('customers:errors.notFound');

  await audit(ctx, {
    action: parsed.data.granted ? 'customer.consent_granted' : 'customer.consent_withdrawn',
    entityType: 'customer',
    entityId: parsed.data.customerId,
    after: { marketingConsent: parsed.data.granted },
  });

  return ok(parsed.data.granted ? 'customers:consent.granted' : 'customers:consent.withdrawn');
}

/**
 * «أعد حساب المجاميع» — rebuild one row's aggregates from its orders.
 *
 * It is on the screen rather than only in a job because the merchant is the one who notices: they
 * cancel an order, the customer's «إجمالي الشراء» still counts it, and the number they are looking at
 * is wrong until something re-runs the query. The cross-file hook that makes this rare — a recompute
 * on every status change and cancellation — is in `docs/PHASE-9-track-e-handoff.md`, because those
 * files are not this track's; this control is what makes the screen honest in the meantime.
 *
 * `incomplete_scan` is reported rather than swallowed. `recomputeCustomerTotals` refuses to write a
 * total it could not finish computing, and a button that said «تم» after changing nothing would be
 * worse than one that says the shop has too many orders for this to run here.
 */
export async function recomputeAction(
  ctx: MerchantContext,
  customerId: string,
): Promise<ActionState> {
  const phone = await customerPhoneById(ctx.db, ctx.tenantId, customerId);
  if (phone === null) return failure('customers:errors.notFound');

  const result = await recomputeCustomerTotals(ctx.db, ctx.tenantId, phone);
  return result.ok ? ok('customers:detail.recomputed') : failure('customers:errors.recomputeTooLarge');
}
