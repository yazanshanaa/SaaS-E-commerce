/**
 * The StorageAdapter contract.
 *
 * A3 builds the production R2 driver inside `src/server/media/storage` and registers it here.
 * The INTERFACE lives outside A3's folder on purpose: `src/server/export` (Phase 1) depends on
 * it, and A3 merges after Phase 1. A contract that only exists inside the folder that
 * implements it cannot be depended on by the folder that ships first.
 *
 * The surface is fixed now because later tracks are forbidden from touching the S3 client and
 * cannot add methods to a merged folder:
 *   - `deleteByPrefix` — B1's purge and B3's close-demo remove everything under a tenant,
 *   - `delete`         — B1's reactivation removes exactly ONE object (the export artifact) on
 *                        a LIVE tenant, where deleteByPrefix would destroy every product image.
 *                        Prefix-matching is not an acceptable stand-in for a single-object
 *                        delete,
 *   - `signedUrl`      — minted per request by the /export route, ttl ≤ 1h.
 *
 * HARD CEILING, documented here because it is the reason Q18 exists in the shape it does:
 * SigV4 caps presigned validity at 604800 seconds (7 days) and R2 enforces the S3 limit. This
 * method must NEVER be offered as a durable link. A 30-day promise built on a presign dies
 * silently on day 8 — for the merchant most likely to need it, the one who waited.
 */

export const MAX_SIGNED_URL_TTL_SECONDS = 3600;

export interface PutObjectOptions {
  contentType?: string;
  /** Server-side encryption. Required for anything under `_exports/`. */
  encrypt?: boolean;
  /** Cache-Control for CDN-served media. Never set on an export artifact. */
  cacheControl?: string;
  contentDisposition?: string;
}

export interface StoredObject {
  key: string;
  size: number;
  contentType?: string;
  lastModified?: Date;
}

export interface StorageAdapter {
  readonly driver: 'local' | 'r2';

  put(key: string, body: Buffer | Uint8Array | string, options?: PutObjectOptions): Promise<StoredObject>;
  get(key: string): Promise<Buffer>;
  exists(key: string): Promise<boolean>;
  head(key: string): Promise<StoredObject | null>;

  /** Removes EXACTLY one object. Never emulate this with a prefix delete. */
  delete(key: string): Promise<void>;

  /** Removes everything under a prefix. The purge path; also close-demo. */
  deleteByPrefix(prefix: string): Promise<number>;

  list(prefix: string, limit?: number): Promise<StoredObject[]>;

  /**
   * A short-lived signed URL. `ttlSeconds` is clamped to MAX_SIGNED_URL_TTL_SECONDS by every
   * implementation — the ceiling is not the caller's to raise.
   */
  signedUrl(key: string, ttlSeconds: number): Promise<string>;

  /**
   * The public CDN URL for a MEDIA object. Throws for any key outside the media segment: the
   * CDN origin is restricted to `media/`, and an export artifact is a whole business in one
   * file.
   */
  publicUrl(key: string): string;
}

// --- Key layout ---------------------------------------------------------------
// Everything a tenant owns lives under ONE prefix, so purge's deleteByPrefix sweeps it by
// construction rather than by remembering to.

export function tenantPrefix(tenantId: string): string {
  return `tenants/${tenantId}/`;
}

export function mediaPrefix(tenantId: string): string {
  return `${tenantPrefix(tenantId)}media/`;
}

export function exportsPrefix(tenantId: string): string {
  return `${tenantPrefix(tenantId)}_exports/`;
}

/** Self-serve exports live under a tmp/ segment so a cleanup job can sweep them at 24h. */
export function selfServeExportsPrefix(tenantId: string): string {
  return `${exportsPrefix(tenantId)}tmp/`;
}

/** True for keys A3's orphan cleanup must SKIP: they have no Media row by design. */
export function isExportKey(key: string): boolean {
  return /^tenants\/[^/]+\/_exports\//.test(key);
}

export function isMediaKey(key: string): boolean {
  return /^tenants\/[^/]+\/media\//.test(key);
}

export class StorageError extends Error {
  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'StorageError';
  }
}
