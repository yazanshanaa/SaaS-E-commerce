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
  /** B1 completes the images half; Phase 1 ships products CSV only. */
  includeImages?: boolean;
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
    images: number;
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
