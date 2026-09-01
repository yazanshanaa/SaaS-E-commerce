import { z } from 'zod';
import { GATEWAY_PROVIDERS } from '@/server/payments/types';
import { CART_ORDER_STATUSES, ORDER_STATUSES } from './status';

/**
 * Every Phase 5 input, validated at the boundary (invariant 3).
 *
 * Schemas live beside the service rather than in the route files — the `src/server/push`
 * precedent — so a route handler holds a gate ladder and nothing else, and so the same schema
 * validates a storefront POST and a dashboard action without either importing the other's folder.
 *
 * MESSAGES ARE i18n KEYS, never sentences. `namespace:dotted.key`, matching the shape
 * `fieldErrorsFromZod` accepts; anything else is replaced by a generic message, which is how an
 * English zod default is stopped from reaching a customer.
 */

export const CHECKOUT_MAX_QUANTITY = 99;
export const CHECKOUT_MAX_NOTE = 500;

/**
 * A customer's phone number, accepted the way a customer actually types it.
 *
 * The merchant's OWN WhatsApp number (`optionalWhatsappField`) demands strict international form,
 * because a wrong country code there sends every order on the site to a stranger. This field is
 * the opposite situation: the number is only ever read back by the merchant who is about to call
 * it, and a customer in Bartaa types `0599123456`. Refusing that would lose the order to protect
 * nothing.
 *
 * So: separators are stripped, an optional leading `+` is kept, and the result must be 9-15
 * digits. What is stored is the cleaned string, not the raw input.
 */
export const phoneField = z
  .string({ message: 'storefront:checkout.errors.phone' })
  .trim()
  .transform((value) => {
    const digits = value.replace(/\D/g, '');
    return value.trim().startsWith('+') ? `+${digits}` : digits;
  })
  .refine((value) => /^\+?\d{9,15}$/.test(value), {
    message: 'storefront:checkout.errors.phone',
  });

export const checkoutSchema = z.object({
  /**
   * NAMED even though a customer never sees it. Zod's own default for a `min(1)` failure is
   * `Too small: expected string to have >=1 characters` — an English sentence that CONTAINS A
   * COLON, which is exactly the shape `fieldErrorsFromZod` had to stop mistaking for a namespaced
   * key (see `src/app/dashboard/_lib/validation.ts`). Leaving any field unnamed keeps that trap
   * one refactor away from being live again.
   */
  productSlug: z
    .string()
    .trim()
    .min(1, 'storefront:checkout.errors.failed')
    .max(120, 'storefront:checkout.errors.failed'),
  quantity: z
    .number({ message: 'storefront:checkout.errors.quantity' })
    .int('storefront:checkout.errors.quantity')
    .min(1, 'storefront:checkout.errors.quantity')
    .max(CHECKOUT_MAX_QUANTITY, 'storefront:checkout.errors.quantity'),
  customerName: z
    .string({ message: 'storefront:checkout.errors.name' })
    .trim()
    .min(2, 'storefront:checkout.errors.name')
    .max(120, 'storefront:checkout.errors.name'),
  customerPhone: phoneField,
  customerNote: z
    .string({ message: 'storefront:checkout.errors.note' })
    .trim()
    .max(CHECKOUT_MAX_NOTE, 'storefront:checkout.errors.note')
    .optional()
    .transform((value) => (value === '' ? undefined : value)),
});

export type CheckoutInput = z.infer<typeof checkoutSchema>;

export const orderStatusChangeSchema = z.object({
  orderId: z.string().trim().min(1, 'dashboard:errors.required'),
  status: z.enum(ORDER_STATUSES, { message: 'dashboard:orders.errors.illegalTransition' }),
});

/**
 * The super admin's gateway form.
 *
 * `credentials` is a free-form record because the field NAMES come from the adapter, not from
 * this schema — a provider-specific object here would have to be edited every time a provider is
 * activated. The values are bounded, and `saveGatewayCredentials` intersects the submitted keys
 * with `adapter.credentialFields` before anything is sealed, so an unknown key is dropped rather
 * than stored.
 *
 * An EMPTY value means "leave the stored one alone" — the admin form never re-displays a saved
 * credential, so a blank box is the only way to say "unchanged" without printing the secret.
 */
export const gatewayConfigSchema = z.object({
  provider: z.enum(GATEWAY_PROVIDERS, { message: 'admin:errors.unknownProvider' }),
  credentials: z.record(z.string(), z.string().trim().max(2_000)).default({}),
  instructions: z
    .string()
    .trim()
    .max(1_000, 'admin:errors.textTooLong')
    .optional()
    .transform((value) => (value === '' ? undefined : value)),
});

export type GatewayConfigInput = z.infer<typeof gatewayConfigSchema>;

/** The merchant's own half: the selling switch plus the Arabic payment instructions. */
export const merchantPaymentsSchema = z.object({
  sellingEnabled: z.boolean(),
  instructions: z
    .string()
    .trim()
    .max(1_000, 'dashboard:errors.textTooLong')
    .optional()
    .transform((value) => (value === '' ? undefined : value)),
});

export type MerchantPaymentsInput = z.infer<typeof merchantPaymentsSchema>;

// =============================================================================
// Phase 8 — cart, checkout settings and coupons. Everything below is validated at the
// boundary exactly like the Phase 5 schemas above (invariant 3); every message is a namespaced
// i18n key, never a sentence.
// =============================================================================

export const CART_MAX_LINE_ITEMS = 50;
export const TRACKING_CODE_MIN_LENGTH = 8;

const cartItemSchema = z.object({
  productSlug: z
    .string()
    .trim()
    .min(1, 'storefront:cart.errors.failed')
    .max(120, 'storefront:cart.errors.failed'),
  quantity: z
    .number({ message: 'storefront:cart.errors.quantity' })
    .int('storefront:cart.errors.quantity')
    .min(1, 'storefront:cart.errors.quantity')
    .max(CHECKOUT_MAX_QUANTITY, 'storefront:cart.errors.quantity'),
});

export type CartItemInput = z.infer<typeof cartItemSchema>;

const orderPaymentMethodSchema = z.enum(['cod', 'pickup', 'gateway'], {
  message: 'storefront:cart.errors.paymentMethod',
});

/**
 * A coupon code as a CUSTOMER types it — trimmed and uppercased before it ever reaches the
 * service, so `redeemCoupon`'s own `WHERE code = $1` never has to case-fold. An empty string
 * (the field left blank) becomes `undefined`, not a lookup for a coupon whose code is `""`.
 */
const couponCodeField = z
  .string()
  .trim()
  .max(40, 'storefront:cart.errors.couponInvalid')
  .transform((value) => value.toUpperCase())
  .optional()
  .transform((value) => (value === '' || value === undefined ? undefined : value));

/**
 * The cart page's "recompute the totals" preview — items and an optional coupon, nothing that
 * touches identity. Reused by the real checkout below via `.extend`, so the two can never drift.
 */
export const cartQuoteSchema = z.object({
  items: z
    .array(cartItemSchema)
    .min(1, 'storefront:cart.errors.empty')
    .max(CART_MAX_LINE_ITEMS, 'storefront:cart.errors.tooManyItems'),
  couponCode: couponCodeField,
  /**
   * Phase 9. Both optional: the cart page re-quotes as soon as the customer names their town, so
   * the zone's fee, its ETA and «ما بنوصّل لهذه البلدة» appear BEFORE the checkout form rather than
   * after it — which is the difference between choosing another town and abandoning the cart.
   *
   * `cartCheckoutSchema` extends this object and declares its own `deliveryArea` and
   * `paymentMethod`; `.extend` on the child wins, so checkout keeps its stricter pair.
   */
  deliveryArea: z
    .string()
    .trim()
    .max(80, 'storefront:cart.errors.deliveryArea')
    .optional()
    .transform((value) => (value === '' ? undefined : value)),
  paymentMethod: orderPaymentMethodSchema.optional(),
});

export type CartQuoteInput = z.infer<typeof cartQuoteSchema>;

/**
 * Checkout itself. `deliveryArea` and `deliveryAddress` are validated for SHAPE here; whether
 * they are REQUIRED depends on the tenant's own `OrderSettings.deliveryAreas` and the chosen
 * payment method, which this schema has no way to know — `checkoutCart` (src/server/orders
 * /checkout.ts) enforces that against the loaded settings, the same split `checkoutSchema`
 * already draws between shape and business rules.
 */
export const cartCheckoutSchema = cartQuoteSchema.extend({
  customerName: z
    .string({ message: 'storefront:checkout.errors.name' })
    .trim()
    .min(2, 'storefront:checkout.errors.name')
    .max(120, 'storefront:checkout.errors.name'),
  customerPhone: phoneField,
  customerNote: z
    .string({ message: 'storefront:checkout.errors.note' })
    .trim()
    .max(CHECKOUT_MAX_NOTE, 'storefront:checkout.errors.note')
    .optional()
    .transform((value) => (value === '' ? undefined : value)),
  deliveryArea: z
    .string()
    .trim()
    .max(80, 'storefront:cart.errors.deliveryArea')
    .optional()
    .transform((value) => (value === '' ? undefined : value)),
  deliveryAddress: z
    .string()
    .trim()
    .max(500, 'storefront:cart.errors.deliveryAddress')
    .optional()
    .transform((value) => (value === '' ? undefined : value)),
  paymentMethod: orderPaymentMethodSchema,
});

export type CartCheckoutInput = z.infer<typeof cartCheckoutSchema>;

/** The merchant order inbox's status-tab move — the cart-channel twin of `orderStatusChangeSchema`. */
export const cartOrderStatusChangeSchema = z.object({
  orderId: z.string().trim().min(1, 'dashboard:errors.required'),
  status: z.enum(CART_ORDER_STATUSES, { message: 'dashboard:orders.errors.illegalTransition' }),
});

/**
 * Shared by BOTH a customer's self-service edit (window + status gated,
 * src/server/orders/self-service.ts) and a merchant's manual edit from the order detail screen
 * (no window, session-authenticated). Deliberately does NOT include line items or quantities —
 * `OrderItem` is a price SNAPSHOT the same way Phase 5 left it, and reopening it to edits would
 * mean recomputing totals, re-validating a spent coupon and re-checking stock outside the
 * transaction that originally proved all three, which is a materially different feature.
 */
export const orderContactEditSchema = z.object({
  customerName: z
    .string({ message: 'storefront:checkout.errors.name' })
    .trim()
    .min(2, 'storefront:checkout.errors.name')
    .max(120, 'storefront:checkout.errors.name'),
  customerPhone: phoneField,
  deliveryArea: z
    .string()
    .trim()
    .max(80, 'storefront:cart.errors.deliveryArea')
    .optional()
    .transform((value) => (value === '' ? undefined : value)),
  deliveryAddress: z
    .string()
    .trim()
    .max(500, 'storefront:cart.errors.deliveryAddress')
    .optional()
    .transform((value) => (value === '' ? undefined : value)),
  customerNote: z
    .string({ message: 'storefront:checkout.errors.note' })
    .trim()
    .max(CHECKOUT_MAX_NOTE, 'storefront:checkout.errors.note')
    .optional()
    .transform((value) => (value === '' ? undefined : value)),
});

export type OrderContactEditInput = z.infer<typeof orderContactEditSchema>;

const CANCEL_REASON_MAX = 300;

/** Cancel is soft with a reason (never a hard delete) — required, on both the self-service and
 *  the merchant path. */
export const orderCancelSchema = z.object({
  reason: z
    .string({ message: 'storefront:order.errors.reasonRequired' })
    .trim()
    .min(1, 'storefront:order.errors.reasonRequired')
    .max(CANCEL_REASON_MAX, 'storefront:order.errors.reasonTooLong'),
});

export type OrderCancelInput = z.infer<typeof orderCancelSchema>;

/** A merchant's internal note — never shown to the customer. */
export const orderNoteSchema = z.object({
  note: z
    .string({ message: 'dashboard:orders.errors.noteRequired' })
    .trim()
    .min(1, 'dashboard:orders.errors.noteRequired')
    .max(1_000, 'dashboard:orders.errors.noteTooLong'),
});

export type OrderNoteInput = z.infer<typeof orderNoteSchema>;

/**
 * The public tracking page's gate: the code from the URL plus the last four digits of the
 * order's own phone number — never a session, never a cookie, re-checked on every call
 * (src/server/orders/self-service.ts).
 */
export const trackingLookupSchema = z.object({
  trackingCode: z
    .string()
    .trim()
    .min(TRACKING_CODE_MIN_LENGTH, 'storefront:order.errors.notFound')
    .max(40, 'storefront:order.errors.notFound'),
  phoneLast4: z
    .string({ message: 'storefront:order.errors.phoneLast4' })
    .trim()
    .regex(/^\d{4}$/, 'storefront:order.errors.phoneLast4'),
});

export type TrackingLookupInput = z.infer<typeof trackingLookupSchema>;

/**
 * Per-tenant checkout policy, capability `order_settings`. `editWindowMinutes` is bounded to a
 * sane shape here (a week) — the PLATFORM cap from `platform_settings` is a second, tighter,
 * always-enforced ceiling applied by `saveOrderSettings` itself, never by this schema, because
 * that number can change without a code deploy.
 */
export const orderSettingsSchema = z.object({
  editWindowMinutes: z
    .number({ message: 'dashboard:orderSettings.errors.editWindow' })
    .int('dashboard:orderSettings.errors.editWindow')
    .min(0, 'dashboard:orderSettings.errors.editWindow')
    .max(10_080, 'dashboard:orderSettings.errors.editWindow'),
  deliveryFeeAgorot: z
    .number({ message: 'dashboard:orderSettings.errors.amount' })
    .int('dashboard:orderSettings.errors.amount')
    .min(0, 'dashboard:orderSettings.errors.amount'),
  freeDeliveryOverAgorot: z
    .number()
    .int('dashboard:orderSettings.errors.amount')
    .min(0, 'dashboard:orderSettings.errors.amount')
    .nullable()
    .optional(),
  minOrderAmountAgorot: z
    .number({ message: 'dashboard:orderSettings.errors.amount' })
    .int('dashboard:orderSettings.errors.amount')
    .min(0, 'dashboard:orderSettings.errors.amount'),
  paymentMethods: z
    .array(orderPaymentMethodSchema)
    .min(1, 'dashboard:orderSettings.errors.paymentMethods')
    .transform((values) => Array.from(new Set(values))),
  deliveryAreas: z
    .array(z.string().trim().min(1).max(80))
    .max(200, 'dashboard:orderSettings.errors.deliveryAreas')
    .default([]),
  orderingPaused: z.boolean(),
});

export type OrderSettingsInput = z.infer<typeof orderSettingsSchema>;

const couponTypeSchema = z.enum(['percent', 'fixed', 'free_delivery'], {
  message: 'dashboard:coupons.errors.type',
});
const couponScopeSchema = z.enum(['all', 'categories', 'products'], {
  message: 'dashboard:coupons.errors.scope',
});

/**
 * A merchant creating or editing a coupon. `code` is normalised the same way the customer-facing
 * `couponCodeField` above is, so `coupons_code_uppercase` (migration 0004) never fires against
 * application-written data — it exists only as the backstop for a path that forgets.
 */
export const couponSchema = z
  .object({
    code: z
      .string({ message: 'dashboard:coupons.errors.code' })
      .trim()
      .min(2, 'dashboard:coupons.errors.code')
      .max(40, 'dashboard:coupons.errors.code')
      .regex(/^[A-Za-z0-9_-]+$/, 'dashboard:coupons.errors.code')
      .transform((value) => value.toUpperCase()),
    type: couponTypeSchema,
    value: z
      .number({ message: 'dashboard:coupons.errors.value' })
      .int('dashboard:coupons.errors.value')
      .min(0, 'dashboard:coupons.errors.value'),
    minSubtotalAgorot: z
      .number({ message: 'dashboard:coupons.errors.value' })
      .int('dashboard:coupons.errors.value')
      .min(0, 'dashboard:coupons.errors.value')
      .default(0),
    maxUses: z
      .number()
      .int('dashboard:coupons.errors.value')
      .min(1, 'dashboard:coupons.errors.value')
      .nullable()
      .optional(),
    perPhoneLimit: z
      .number()
      .int('dashboard:coupons.errors.value')
      .min(1, 'dashboard:coupons.errors.value')
      .nullable()
      .optional(),
    startsAt: z.coerce.date().nullable().optional(),
    endsAt: z.coerce.date().nullable().optional(),
    active: z.boolean().default(true),
    scope: couponScopeSchema.default('all'),
    scopeCategoryIds: z.array(z.string()).max(200).default([]),
    scopeProductIds: z.array(z.string()).max(500).default([]),
  })
  .refine((value) => value.type !== 'percent' || (value.value >= 1 && value.value <= 100), {
    message: 'dashboard:coupons.errors.percentRange',
    path: ['value'],
  })
  .refine((value) => !value.startsAt || !value.endsAt || value.startsAt <= value.endsAt, {
    message: 'dashboard:coupons.errors.dateRange',
    path: ['endsAt'],
  })
  .refine((value) => value.scope !== 'categories' || value.scopeCategoryIds.length > 0, {
    message: 'dashboard:coupons.errors.scopeEmpty',
    path: ['scopeCategoryIds'],
  })
  .refine((value) => value.scope !== 'products' || value.scopeProductIds.length > 0, {
    message: 'dashboard:coupons.errors.scopeEmpty',
    path: ['scopeProductIds'],
  });

export type CouponInput = z.infer<typeof couponSchema>;
