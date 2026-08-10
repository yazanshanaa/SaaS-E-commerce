/**
 * `exportTenantData(tenantId, { mode })` — ONE contract, TWO callers with different lifetimes.
 *
 * mode 'suspension'  (B1, EVERY plan, Q18)
 *   Written to a DETERMINISTIC key so a retry overwrites instead of orphaning a second copy of
 *   a merchant's whole catalogue. Stamps `exportKey` and `exportGeneratedAt` on the
 *   Subscription. Handed over as a stable platform link, `app.{DOMAIN}/export/{token}`.
 *
 * mode 'self_serve'  (B2, behind can(data_export))
 *   Written under a `tmp/` segment, handed over with a short-lived signed URL, deleted by a
 *   cleanup job within 24h, and NEVER touches the Subscription's export columns — otherwise a
 *   pro merchant clicking "تصدير" would silently clobber the artifact a suspended merchant was
 *   sent, and the link in their WhatsApp would start downloading someone else's timing.
 *
 * Both modes live under the tenant's OWN prefix, so purge's deleteByPrefix sweeps them by
 * construction. The artifact is encrypted at rest and its prefix is NOT reachable through the
 * public CDN — it is a whole business in one file, and the media prefix is public.
 *
 * It does not count against `storage_mb`: the merchant must not be billed quota for the copy
 * we hand them on the way out.
 */

import type { TenantTx } from '@/server/db';

export const EXPORT_MODES = ['suspension', 'self_serve'] as const;
export type ExportMode = (typeof EXPORT_MODES)[number];

export interface ExportOptions {
  mode: ExportMode;
  /**
   * Required for 'suspension': the key is `{subscriptionId}-{suspendedAt}.zip`, which is what
   * makes a retry idempotent.
   */
  subscriptionId?: string;
  suspendedAt?: Date;
  /** Who asked. Recorded in the audit row for a self-serve export. */
  actorUserId?: string | null;
  /** Defaults to true since B1. Set false only for a catalogue-only export. */
  includeImages?: boolean;
  /**
   * The caller's own transaction, when it already holds one.
   *
   * The `build-export` processor runs inside the transaction `createWorker` opens for every
   * TenantJob. Without this, `exportTenantData` would open a SECOND transaction on a second
   * connection for reads that the caller's transaction could already answer — and the two would
   * see different snapshots, so a catalogue could change between the CSV and the image
   * inventory. Passing the transaction in makes the export one consistent read of one moment.
   */
  tx?: TenantTx;
}

export interface ExportArtifact {
  key: string;
  sizeBytes: number;
  mode: ExportMode;
  generatedAt: Date;
  /** What actually went in — so the caller can tell the merchant, and B1 can assert. */
  contents: {
    products: number;
    categories: number;
    /** Image FILES in the archive, not ProductImage rows. */
    images: number;
    /**
     * Images the archive does not contain: still processing, or past the in-memory budget in
     * `images.ts`, or unreadable from storage. Written into the README the merchant opens —
     * a cap nobody is told about reads as "we gave you everything".
     */
    imagesOmitted: number;
  };
}

export class ExportError extends Error {
  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'ExportError';
  }
}

export class ExportModeError extends ExportError {
  constructor(message: string) {
    super(message);
    this.name = 'ExportModeError';
  }
}
