import { messageExists, t, type Namespace } from '@/shared/i18n';
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
]);

export function resolveMessage(key: string | undefined): string {
  if (!key) return '';

  const separator = key.indexOf(':');
  if (separator === -1) return t('dashboard', 'errors.unexpected');

  const namespace = key.slice(0, separator) as Namespace;
  const path = key.slice(separator + 1);

  if (!NAMESPACES.has(namespace)) return t('dashboard', 'errors.unexpected');
  // `t()` throws on a missing key outside production, and a form that crashes while trying to
  // explain a validation failure is a worse outcome than a generic message.
  if (!messageExists(namespace, path)) return t('dashboard', 'errors.unexpected');

  return t(namespace, path);
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
