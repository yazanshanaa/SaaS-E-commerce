import { messageExists, t, type MessageParams, type Namespace } from '@/shared/i18n';

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
  // Phase 9's five per-domain catalogues. The admin surface needs all five, not just the ones its
  // own screens write: `submitChangeRequest` echoes a merchant-authored payload's validation keys
  // back to the operator, so a `delivery:` or `catalogue:` key reaches THIS resolver.
  //
  // Kept as a second literal rather than exported from one place: this set is an allow-list, and an
  // allow-list shared between the platform-owner surface and the tenant surface is one edit away
  // from widening both at once. The cost of the duplication is that both must be updated together;
  // the cost of sharing it is that neither can be narrowed alone.
  'catalogue',
  'content',
  'insights',
  'delivery',
  'customers',
  // Phase 11: the appearance studio's copy — the admin's template pickers reuse its card grid.
  'appearance',
]);

export function resolveMessage(key: string | undefined, params?: MessageParams): string {
  if (!key) return '';

  const separator = key.indexOf(':');
  if (separator === -1) return t('admin', 'errors.unexpected');

  const namespace = key.slice(0, separator) as Namespace;
  const path = key.slice(separator + 1);

  if (!NAMESPACES.has(namespace)) return t('admin', 'errors.unexpected');
  // `t()` throws on a missing key outside production, and a form that crashes while trying to
  // explain a validation failure is a worse outcome than a generic message.
  if (!messageExists(namespace, path)) return t('admin', 'errors.unexpected');

  return t(namespace, path, params);
}

/**
 * Phase 9. A redirect banner's short CODE (`carrierSaved`) into a full key, bounded to one namespace.
 *
 * Same function, same reasoning and the same trap as the merchant surface's copy — the long version is
 * in `src/app/dashboard/_components/messages.ts`. Short version: the code arrives in a query string, so
 * a crafted link chooses it; prefixing on the read side means the URL can only ever name a message in
 * the namespace the page named, and only inside its `notices.*` block.
 *
 * Not shared with the merchant copy for the same reason `NAMESPACES` is not: these two surfaces have
 * different audiences, and a helper both import is a helper that widens both at once.
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
