import { messageExists, t, type Namespace } from '@/shared/i18n';

/**
 * Resolve a `namespace:dotted.key` returned by a public server action.
 *
 * The same vocabulary A1's panel uses (`src/app/admin/_components/messages.ts`) and a separate
 * ten-line copy rather than an import across surfaces: the public tree must not depend on the admin
 * tree, which is guarded by a session on every path and merges on a different schedule.
 *
 * Anything that is not in the expected shape becomes the generic Arabic apology instead of being
 * printed. A raw key on screen is a bug report the visitor has to read on our behalf, and an
 * un-namespaced string arriving here means a library's English message slipped through.
 */

const NAMESPACES = new Set<Namespace>(['common', 'demo']);

export function resolvePublicMessage(key: string | undefined): string {
  if (!key) return '';

  const separator = key.indexOf(':');
  if (separator === -1) return t('demo', 'request.errors.unexpected');

  const namespace = key.slice(0, separator) as Namespace;
  const path = key.slice(separator + 1);

  if (!NAMESPACES.has(namespace)) return t('demo', 'request.errors.unexpected');
  // `t()` throws on a missing key outside production, and a form that crashes while explaining a
  // validation failure is worse than one that says something generic.
  if (!messageExists(namespace, path)) return t('demo', 'request.errors.unexpected');

  return t(namespace, path);
}
