import { z } from 'zod';
import { getEnv } from '@/env';
import { normaliseHostname } from '@/server/tenancy';

/**
 * What may become a merchant's custom domain.
 *
 * Two refusals here are load-bearing rather than tidy:
 *
 *   1. NOTHING UNDER THE PLATFORM DOMAIN. `Domain.hostname` is globally unique and is the table
 *      `proxy.ts` resolves strangers against, so a row for `admin.{DOMAIN}` would be a merchant
 *      claiming the platform owner's hostname. It could not actually serve — `parseHostname()`
 *      classifies that name as the admin surface long before the table is consulted — but the row
 *      would sit there permanently blocking the real thing and looking, in the merchant's own
 *      dashboard, like a domain they own.
 *   2. NO BARE IP. The pattern below is happy with `1.2.3.4`, and an IP cannot hold a CNAME, so
 *      the merchant would be sent round a verification loop that can never close. The last label
 *      must contain a letter.
 */

/** Labels: 1-63 chars, no leading or trailing hyphen, at least two of them. */
const HOSTNAME_PATTERN =
  /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/;

/**
 * Everything a merchant might paste into the box, reduced to a hostname.
 *
 * A shop owner copies the address bar, so `https://shop.example.com/products?x=1` is the ORDINARY
 * input, not the malicious one. Silently accepting it and storing the whole string would put a
 * URL in a column `proxy.ts` matches a `Host` header against — a domain that verifies and then
 * never resolves. The trailing dot is stripped for the same reason: `shop.example.com.` is a
 * legal FQDN that no `Host` header ever carries.
 */
export function normaliseDomainInput(raw: string): string {
  let value = raw.trim().toLowerCase();

  // Scheme and anything after the authority.
  value = value.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  value = value.split('/')[0]!;
  value = value.split('?')[0]!;
  value = value.split('#')[0]!;
  // Credentials, if someone pasted a full URL with them.
  const at = value.lastIndexOf('@');
  if (at !== -1) value = value.slice(at + 1);

  value = normaliseHostname(value);
  return value.replace(/\.+$/, '');
}

/** Is this name the platform's own — the wildcard certificate's territory, not a merchant's? */
export function isPlatformHostname(hostname: string): boolean {
  const domain = getEnv().DOMAIN.toLowerCase();
  const host = normaliseHostname(hostname);
  return host === domain || host.endsWith(`.${domain}`);
}

/** A TLD made only of digits is not a TLD; this is how a bare IPv4 address is refused. */
function hasAlphabeticTld(hostname: string): boolean {
  const last = hostname.split('.').pop() ?? '';
  return /[a-z]/.test(last);
}

/**
 * The merchant-facing schema. Messages are `dashboard:errors.*` keys, never sentences — code is
 * English and copy is Arabic, so a server module holds neither.
 */
export const customHostnameSchema = z
  .string()
  .min(1, 'dashboard:errors.required')
  .transform(normaliseDomainInput)
  .refine((value) => value.length >= 4 && value.length <= 253, 'dashboard:errors.invalidValue')
  .refine((value) => HOSTNAME_PATTERN.test(value), 'dashboard:errors.invalidValue')
  .refine(hasAlphabeticTld, 'dashboard:errors.invalidValue')
  .refine((value) => !isPlatformHostname(value), 'dashboard:domain.errors.platformReserved');

/**
 * The value the merchant's CNAME must point at: their own platform subdomain.
 *
 * Deliberately not a single shared `cname.{DOMAIN}` target. Pointing every merchant at one name
 * would mean the CNAME carries no information about WHO is asking, so the ask endpoint could only
 * ever say "yes, this is one of ours" — and any stranger who pointed a CNAME at it would be
 * indistinguishable from the tenant that actually holds the row. Per-tenant, the DNS record is
 * itself the proof of control, which is what makes the CNAME path a verification method at all
 * rather than a convenience.
 */
export function cnameTarget(slug: string): string {
  return `${slug}.${getEnv().DOMAIN.toLowerCase()}`;
}

/** The TXT record name and value for the fallback method: `souq-verify={token}`. */
export const VERIFICATION_TXT_PREFIX = 'souq-verify=';
export const VERIFICATION_TXT_LABEL = '_souq-verify';

export function verificationTxtValue(token: string): string {
  return `${VERIFICATION_TXT_PREFIX}${token}`;
}

/**
 * The example a merchant is shown, as DATA rather than as copy.
 *
 * `shop.example.com` is a placeholder, not vocabulary, so it must not sit inside an Arabic
 * sentence in `messages/ar` — the language gate is right to refuse a stray Latin word there, and
 * a second locale should be free to pick a different example. It travels as an i18n parameter
 * instead, from here, so the hint and the field label can never drift apart.
 *
 * `example.com` is the RFC 2606 reserved name: it is guaranteed never to belong to anyone, so a
 * merchant who copies the example verbatim cannot accidentally point at a real business.
 */
export const EXAMPLE_HOSTNAME = 'shop.example.com';
export const EXAMPLE_HOSTNAME_LABEL = 'shop';

export function verificationTxtNames(hostname: string): string[] {
  // Both names are accepted. The apex `shop.example.com` form is what the phase brief names, and
  // it is the one many providers REFUSE once a CNAME exists on the same name (a CNAME must be
  // alone in its record set) — so `_souq-verify.shop.example.com` is offered beside it, and the
  // instructions show whichever the merchant's situation allows.
  return [hostname, `${VERIFICATION_TXT_LABEL}.${hostname}`];
}
