import { z } from 'zod';
import { GATEWAY_PROVIDERS } from '@/server/payments/types';
import { ORDER_STATUSES } from './status';

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
const phoneField = z
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
