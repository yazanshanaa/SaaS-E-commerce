import { messageExists, t, type MessageParams, type Namespace } from '@/shared/i18n';
import type { FieldError } from '../_lib/validation';

/**
 * Server actions return i18n KEYS, never sentences (see `_lib/validation.ts`). This resolves one.
 *
 * A key looks like `dashboard:errors.slugTaken` — namespace, colon, dotted path. Anything not in
 * that shape becomes the generic unexpected-error message rather than being printed: a raw key
 * on screen is a bug report the merchant has to read on our behalf, and an un-namespaced string
 * reaching here means an English library message slipped through.
 */

const NAMESPACES = new Set<Namespace>([
  'common',
  'admin',
  'dashboard',
  'storefront',
  'media',
  'billing',
  'demo',
  // Phase 9's five per-domain catalogues, registered in `src/shared/i18n/index.ts` since the schema
  // landed (that file explains why five files rather than five blocks inside `dashboard.json`).
  // This set was the ONLY thing keeping them out: an unknown namespace falls through to
  // `errors.unexpected`, so «انحفظت التركيبة» on a save that worked read as an unexpected error.
  // The set is duplicated in `src/app/admin/_components/messages.ts` on purpose — see the note there.
  'catalogue',
  'content',
  'insights',
  'delivery',
  'customers',
  // Phase 11 (Track 11.D): the appearance studio's copy.
  'appearance',
]);

export function resolveMessage(key: string | undefined, params?: MessageParams): string {
  if (!key) return '';

  const separator = key.indexOf(':');
  if (separator === -1) return t('dashboard', 'errors.unexpected');

  const namespace = key.slice(0, separator) as Namespace;
  const path = key.slice(separator + 1);

  if (!NAMESPACES.has(namespace)) return t('dashboard', 'errors.unexpected');
  // `t()` throws on a missing key outside production, and a form that crashes while trying to
  // explain a validation failure is a worse outcome than a generic message.
  if (!messageExists(namespace, path)) return t('dashboard', 'errors.unexpected');

  return t(namespace, path, params);
}

/**
 * Phase 9. A redirect banner's short CODE (`zoneSaved`, `errors.feeTooLarge`) into a full key.
 *
 * Redirect-style actions carry their outcome in the query string, so the value reaching the page is
 * ATTACKER-CHOSEN in the sense that matters: a crafted `/delivery?ok=…` link can be sent to a shop
 * owner. Prefixing here — on the READ side, in the page — is what keeps that bounded: whatever the
 * URL says can only ever name a message inside the one namespace the page named and, unless the page
 * allows a `passthrough` group, only inside its `notices.*` block. Handing `resolveMessage` the raw
 * parameter instead would let the URL pick any key in any of the twelve catalogues, which is how a
 * link ends up showing a merchant «تم إلغاء اشتراكك» on a page that cancelled nothing.
 *
 * `passthrough` exists because the zod schemas already name their own keys (`errors.feeTooLarge`);
 * collapsing those to a generic sentence would leave a dozen written-on-purpose messages unreachable.
 *
 * Replaced Track D's two local `notice.tsx` resolvers, which existed only because `NAMESPACES` above
 * did not know the `delivery` namespace — see docs/PHASE-9-integration.md.
 */
export function noticeKey(
  namespace: Namespace,
  code: string | undefined,
  passthrough: readonly string[] = [],
): string | undefined {
  if (!code) return undefined;
  const verbatim = passthrough.some((prefix) => code.startsWith(prefix));
  return `${namespace}:${verbatim ? code : `notices.${code}`}`;
}

/**
 * A field error's sentence.
 *
 * `message` wins when present: it is an Arabic string another module already resolved through
 * the i18n layer with parameters this surface does not hold (A3's limits, for instance). The
 * key is still carried and is still what the code names, so nothing here invents copy.
 */
export function resolveFieldError(error: FieldError): string {
  return error.message ?? resolveMessage(error.messageKey);
}
