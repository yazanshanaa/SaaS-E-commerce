/**
 * WHAT A TENANT BACKUP CONTAINS — the whole decision, in one list, on purpose.
 *
 * Every tenant-owned table is either INCLUDED or EXCLUDED-with-a-reason. Nothing is unclassified,
 * and `tests/unit/phase10-tenant-backup.test.ts` walks the Prisma DMMF to prove it: a model added
 * in Phase 11 with a `tenantId` and no entry here turns the suite red. That guardrail is the whole
 * value of the file — the failure mode it prevents is silent and delayed, a backup that restores
 * cleanly and is missing the table somebody added last quarter.
 *
 * ORDER IS FOREIGN-KEY ORDER. Parents first: inserts walk the list forwards, deletes walk it
 * backwards. Postgres would catch a violation either way, but as an error mid-restore on a tenant
 * whose tables are already half-emptied — which is a worse place to learn about it than here.
 *
 * WHAT IS NOT HERE, and why it is not an omission:
 *   - `tenants` itself. A restore loads INTO an existing tenant; it never creates one. Creating a
 *     Tenant is `src/server/billing`'s alone (invariant 5, enforced by a guardrail), and a backup
 *     that could resurrect a purged shop would quietly undo the deletion the platform promised.
 *   - Global tables (`plans`, `carriers`, `platform_settings`, the audit logs, the tombstones).
 *     They are not the tenant's, and a "restore" that rewrote the platform's plan catalogue from a
 *     shop's backup would be a cross-tenant write with extra steps.
 *   - `users` and `accounts`. A merchant's login is better-auth's, shared across the platform, and
 *     lives outside the tenant. `members` IS included — the membership is tenant-owned — so a
 *     restore rebuilds who belongs to the shop without touching how they authenticate.
 */

export interface BackupTable {
  /** The Postgres table name, which is what the NDJSON files are named after. */
  table: string;
  /** Included in the artifact AND rewritten on restore. */
  restore: boolean;
  /** Why, in one line, for whoever reads this next. */
  why?: string;
}

/**
 * INCLUDED, in foreign-key order.
 *
 * `subscriptions` and `payments` are in the ARTIFACT and NOT restored, and the asymmetry is
 * invariant 5 rather than an oversight: the standalone bundle needs a shop's billing history to
 * render its own past, while a platform-side restore must never rewrite lifecycle state outside
 * `src/server/billing`. `restore: false` is how one file says both things at once.
 */
export const BACKUP_TABLES: readonly BackupTable[] = [
  // --- the shop's identity and appearance ---------------------------------------
  { table: 'sites', restore: true },
  { table: 'theme_settings', restore: true },
  { table: 'social_links', restore: true },
  { table: 'pages', restore: true },
  { table: 'sections', restore: true },
  { table: 'announcements', restore: true },
  { table: 'testimonials', restore: true },
  { table: 'banners', restore: true },
  { table: 'trust_badges', restore: true },
  { table: 'opening_hours', restore: true },
  { table: 'store_stats', restore: true },

  // --- the catalogue -------------------------------------------------------------
  // `media` before `product_images`, and `categories` before `products`, because that is the
  // direction the foreign keys point.
  { table: 'media', restore: true },
  { table: 'media_variants', restore: true },
  { table: 'categories', restore: true },
  { table: 'products', restore: true },
  { table: 'product_variants', restore: true },
  { table: 'size_guide_entries', restore: true },
  { table: 'product_images', restore: true },

  // --- selling -------------------------------------------------------------------
  { table: 'order_settings', restore: true },
  { table: 'coupons', restore: true },
  { table: 'tenant_counters', restore: true },
  { table: 'orders', restore: true },
  { table: 'order_items', restore: true },
  { table: 'coupon_redemptions', restore: true },
  { table: 'order_history_entries', restore: true },
  { table: 'customers', restore: true },

  // --- delivery and tax ----------------------------------------------------------
  { table: 'tenant_carriers', restore: true },
  { table: 'delivery_zones', restore: true },
  { table: 'delivery_zone_towns', restore: true },
  { table: 'tax_settings', restore: true },

  // --- people and access ---------------------------------------------------------
  // The membership, not the login. See the header.
  { table: 'members', restore: true },
  { table: 'invitations', restore: true },
  // Entitlement OVERRIDES are the tenant's own deviations from its plan; the plan itself is global
  // and is not touched.
  { table: 'entitlements', restore: true },
  { table: 'capability_overrides', restore: true },
  { table: 'change_requests', restore: true },

  // --- reachability --------------------------------------------------------------
  { table: 'domains', restore: true },

  // --- history that is the shop's own record --------------------------------------
  { table: 'consents', restore: true },
  { table: 'notifications', restore: true },
  // Daily ROLLUPS, not raw events — see the exclusions.
  { table: 'analytics_daily', restore: true },
  { table: 'section_dwell_daily', restore: true },
  { table: 'search_query_daily', restore: true },

  // --- in the artifact, never restored (invariant 5) ------------------------------
  {
    table: 'subscriptions',
    restore: false,
    why: 'Lifecycle state changes only through src/server/billing (invariant 5). The standalone bundle needs the row; a platform-side restore must not rewrite it.',
  },
  {
    table: 'payments',
    restore: false,
    why: 'Money. Same rule as subscriptions, and re-inserting settled payments would double a merchant\'s own books.',
  },
  {
    table: 'gateway_configs',
    restore: false,
    why: 'Holds AES-GCM credential ciphertext sealed under THIS deployment\'s ENCRYPTION_KEY. Restoring it elsewhere yields rows nothing can unseal; restoring it here would silently re-enable a gateway an operator disabled.',
  },
  {
    table: 'audit_logs',
    restore: false,
    why: 'An audit trail is append-only truth. It is carried so the artifact is complete, and never rewritten — a log you can restore over is not a log.',
  },
  {
    table: 'events',
    restore: false,
    why: 'Already-emitted events. Re-inserting them would re-materialise deliveries and re-send WhatsApp messages about things that happened months ago.',
  },
] as const;

/**
 * EXCLUDED, each with the reason it is excluded rather than forgotten.
 *
 * The guardrail reads this list too, so "not in the backup" is a decision somebody wrote down.
 */
export const EXCLUDED_TABLES: readonly BackupTable[] = [
  {
    table: 'analytics_events',
    restore: false,
    why: 'Raw 30-day telemetry, the largest table a busy shop has, and already superseded by the daily rollups that ARE included. Backing it up would multiply artifact size for data the platform itself deletes on a timer.',
  },
  {
    table: 'push_subscriptions',
    restore: false,
    why: 'Per-device push CREDENTIALS belonging to visitors, not to the merchant. Restored onto a different deployment they would send that shop\'s notifications from a server the visitor never agreed to; restored here they would resurrect subscriptions a visitor may have withdrawn.',
  },
  {
    table: 'push_messages',
    restore: false,
    why: 'Send history whose audience (above) is deliberately not carried. A history of messages to an audience that no longer exists is a screen full of misleading counts.',
  },
  {
    table: 'demo_links',
    restore: false,
    why: 'Live bearer tokens for a demo storefront. A backup is not a place to keep working credentials, and a demo is not a thing anyone restores.',
  },
  {
    table: 'subscription_reminders',
    restore: false,
    why: 'Idempotency marks for reminders already sent. Restoring them would either re-send a merchant\'s T-7 warning or suppress the next one, depending on the date — both wrong, neither useful.',
  },
  {
    table: 'tenant_backups',
    restore: false,
    why: 'The inventory of backups. A backup that contains its own catalogue is a paradox with no reader.',
  },
] as const;

/** Every table this module has an opinion about — what the DMMF guardrail compares against. */
export const CLASSIFIED_TABLES: readonly string[] = [
  ...BACKUP_TABLES.map((entry) => entry.table),
  ...EXCLUDED_TABLES.map((entry) => entry.table),
];

/** Written into the artifact, in FK order. */
export const DUMP_TABLES: readonly string[] = BACKUP_TABLES.map((entry) => entry.table);

/** Rewritten by a platform-side restore, in FK order. Deletes walk this backwards. */
export const RESTORE_TABLES: readonly string[] = BACKUP_TABLES.filter((entry) => entry.restore).map(
  (entry) => entry.table,
);

/**
 * Restored ONLY by the standalone bootstrap, which is importing into an empty database it just
 * created rather than over a live shop — so invariant 5's "not from here" does not apply, and a
 * bundle with no billing history would render a dashboard that thinks the shop was never paid for.
 */
export const STANDALONE_EXTRA_TABLES: readonly string[] = BACKUP_TABLES.filter(
  (entry) => !entry.restore && entry.table !== 'audit_logs' && entry.table !== 'events',
).map((entry) => entry.table);

export function isBackupTable(table: string): boolean {
  return DUMP_TABLES.includes(table);
}
