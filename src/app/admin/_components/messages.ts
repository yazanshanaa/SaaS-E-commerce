import { messageExists, t, type Namespace } from '@/shared/i18n';

/**
 * Server actions return i18n KEYS, never sentences (see src/server/admin/validation.ts).
 *
 * A key looks like `admin:errors.slugTaken` — namespace, colon, dotted path. This resolves one.
 * Anything that is not in that shape is rendered as the generic unexpected-error message rather
 * than printed: a raw key on screen is a bug report the merchant has to read on our behalf, and
 * an un-namespaced string reaching here means an English library message slipped through.
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
  if (separator === -1) return t('admin', 'errors.unexpected');

  const namespace = key.slice(0, separator) as Namespace;
  const path = key.slice(separator + 1);

  if (!NAMESPACES.has(namespace)) return t('admin', 'errors.unexpected');
  // `t()` throws on a missing key outside production, and a form that crashes while trying to
  // explain a validation failure is a worse outcome than a generic message.
  if (!messageExists(namespace, path)) return t('admin', 'errors.unexpected');

  return t(namespace, path);
}
