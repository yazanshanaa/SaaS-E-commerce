import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  type ServerSideEncryption,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { getEnv } from '@/env';
import {
  MAX_SIGNED_URL_TTL_SECONDS,
  StorageError,
  isMediaKey,
  type PutObjectOptions,
  type StorageAdapter,
  type StoredObject,
} from '@/server/storage';

/**
 * The PRODUCTION storage driver: Cloudflare R2 over the S3 API.
 *
 * This file is the only place in the codebase allowed to import the S3 client — eslint enforces
 * it, and tests/unit/guardrails.test.ts checks the same rule by reading the source. Everything
 * else in the platform talks to `StorageAdapter`, which is why B1 can purge a tenant and B2 can
 * show a media library without either of them knowing R2 exists.
 *
 * Three of the methods carry weight beyond the obvious, and later tracks cannot add them once
 * this folder merges:
 *
 *   - `deleteByPrefix` sweeps everything a tenant owns (B1's purge, B3's close-demo). It refuses
 *     an empty prefix, because "delete everything under ''" is the whole bucket.
 *   - `delete` removes EXACTLY one object. B1's reactivation deletes the export artifact of a
 *     LIVE tenant; emulating that with a prefix delete would take every product image with it.
 *   - `signedUrl` is minted per request by the /export route and clamped here, not by the
 *     caller.
 *
 * HARD CEILING: SigV4 caps presigned validity at 604800 seconds (7 days) and R2 enforces the S3
 * limit. A presigned URL must NEVER be offered as a durable link — Q18's 30-day promise is kept
 * by a platform route (`app.{DOMAIN}/export/{token}`), which is revocable and auditable. A
 * 30-day promise built on a presign dies silently on day 8, for the merchant most likely to need
 * it: the one who waited.
 */

/** The S3/SigV4 ceiling, stated so nobody raises MAX_SIGNED_URL_TTL_SECONDS past reality. */
export const SIGV4_MAX_TTL_SECONDS = 604_800;

/** S3's DeleteObjects accepts at most 1000 keys per call. */
const DELETE_BATCH_SIZE = 1_000;

/** One ListObjectsV2 page. */
const LIST_PAGE_SIZE = 1_000;

export interface R2StorageAdapterOptions {
  /** Injected in tests. Production builds one from the environment on first use. */
  client?: S3Client;
  bucket?: string;
  /** The CDN origin in front of the bucket. Public delivery is never the app server. */
  publicBaseUrl?: string;
}

/**
 * Bucket-level failures that also arrive as a 404.
 *
 * These must NEVER read as "the object is absent". A wrong or drifted `R2_BUCKET` — the web
 * container writing to one bucket and the worker reading from another, or a bucket rename
 * applied to one side first — answers `NoSuchBucket` with HTTP 404. Folded into "not found",
 * that misconfiguration reaches the merchant as `sourceMissing`: a PERMANENT failure, never
 * retried, telling them «ما لقينا ملف الصورة الأصلي» about an object that is sitting safely in
 * the other bucket. The distinction between "gone" and "we are looking in the wrong place" is
 * the difference between a truthful failure and a lie that also loses the photo.
 */
const BUCKET_LEVEL_ERRORS = new Set(['NoSuchBucket', 'PermanentRedirect']);

function errorCode(error: unknown): string {
  const err = error as { name?: string; Code?: string; code?: string };
  return err?.name ?? err?.Code ?? err?.code ?? '';
}

function isNotFound(error: unknown): boolean {
  const err = error as { $metadata?: { httpStatusCode?: number } };
  const code = errorCode(error);
  if (BUCKET_LEVEL_ERRORS.has(code)) return false;
  return code === 'NotFound' || code === 'NoSuchKey' || err?.$metadata?.httpStatusCode === 404;
}

/**
 * The server-side encryption algorithms R2 accepts, checked rather than cast.
 *
 * `R2_SSE_ALGORITHM` is a plain string in `src/env.ts`, so a typo (`AES-256` for `AES256`)
 * validates fine and costs nothing until the FIRST write that asks for encryption — which is the
 * suspension export, the one artifact whose loss is unrecoverable and whose absence the merchant
 * only discovers after being told they had thirty days. Failing at the point of use, naming the
 * variable, is the difference between a five-minute fix and a dead export job nobody can read.
 */
const SUPPORTED_SSE_ALGORITHMS = new Set<ServerSideEncryption>(['AES256', 'aws:kms']);

function sseAlgorithm(value: string): ServerSideEncryption {
  if (!SUPPORTED_SSE_ALGORITHMS.has(value as ServerSideEncryption)) {
    throw new StorageError(
      `R2_SSE_ALGORITHM is set to "${value}", which R2 does not accept. Use one of: ${[...SUPPORTED_SSE_ALGORITHMS].join(', ')}.`,
    );
  }
  return value as ServerSideEncryption;
}

export class R2StorageAdapter implements StorageAdapter {
  readonly driver = 'r2' as const;

  private injectedClient?: S3Client;
  private lazyClient?: S3Client;
  private bucketOverride?: string;
  private publicBaseOverride?: string;

  constructor(options: R2StorageAdapterOptions = {}) {
    this.injectedClient = options.client;
    this.bucketOverride = options.bucket;
    this.publicBaseOverride = options.publicBaseUrl;
  }

  /**
   * Built on first use, never at import. A module that opens a client at import time makes every
   * unit test and every build step depend on credentials being present.
   */
  private client(): S3Client {
    if (this.injectedClient) return this.injectedClient;
    if (this.lazyClient) return this.lazyClient;

    const env = getEnv();
    const endpoint =
      env.R2_ENDPOINT ??
      (env.R2_ACCOUNT_ID ? `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com` : undefined);

    if (!endpoint) {
      throw new StorageError('R2 is not configured: set R2_ENDPOINT or R2_ACCOUNT_ID.');
    }
    if (!env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY) {
      throw new StorageError('R2 is not configured: set R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY.');
    }

    this.lazyClient = new S3Client({
      region: env.R2_REGION,
      endpoint,
      // R2 serves the S3 API path-style; virtual-host style needs per-bucket DNS.
      forcePathStyle: true,
      credentials: {
        accessKeyId: env.R2_ACCESS_KEY_ID,
        secretAccessKey: env.R2_SECRET_ACCESS_KEY,
      },
    });

    return this.lazyClient;
  }

  private bucket(): string {
    return this.bucketOverride ?? getEnv().R2_BUCKET;
  }

  private requireKey(key: string, what: string): string {
    const trimmed = key.trim();
    if (!trimmed) {
      throw new StorageError(`Refusing an empty ${what}.`);
    }
    return trimmed;
  }

  async put(
    key: string,
    body: Buffer | Uint8Array | string,
    options: PutObjectOptions = {},
  ): Promise<StoredObject> {
    const objectKey = this.requireKey(key, 'object key');
    const buffer = typeof body === 'string' ? Buffer.from(body, 'utf8') : Buffer.from(body);
    const env = getEnv();

    /**
     * Resolved OUTSIDE the try, deliberately.
     *
     * Required for anything under `_exports/` — a whole business in one file — and the env value
     * is CHECKED rather than cast. Inside the try, the catch-all below would rewrite the refusal
     * as "Failed to store object: {key}" and throw away the one sentence that names the variable
     * at fault, which is the entire point of validating it.
     */
    const encryption = options.encrypt ? sseAlgorithm(env.R2_SSE_ALGORITHM) : undefined;

    try {
      await this.client().send(
        new PutObjectCommand({
          Bucket: this.bucket(),
          Key: objectKey,
          Body: buffer,
          ContentType: options.contentType,
          CacheControl: options.cacheControl,
          ContentDisposition: options.contentDisposition,
          ServerSideEncryption: encryption,
        }),
      );
    } catch (error) {
      throw new StorageError(`Failed to store object: ${objectKey}`, error);
    }

    return {
      key: objectKey,
      size: buffer.byteLength,
      contentType: options.contentType,
      lastModified: new Date(),
    };
  }

  async get(key: string): Promise<Buffer> {
    const objectKey = this.requireKey(key, 'object key');

    try {
      const response = await this.client().send(
        new GetObjectCommand({ Bucket: this.bucket(), Key: objectKey }),
      );

      const body = response.Body;
      if (!body) {
        throw new StorageError(`Object has no body: ${objectKey}`);
      }

      return Buffer.from(await body.transformToByteArray());
    } catch (error) {
      if (error instanceof StorageError) throw error;
      throw new StorageError(`Object not found: ${objectKey}`, error);
    }
  }

  async exists(key: string): Promise<boolean> {
    return (await this.head(key)) !== null;
  }

  async head(key: string): Promise<StoredObject | null> {
    const objectKey = this.requireKey(key, 'object key');

    try {
      const response = await this.client().send(
        new HeadObjectCommand({ Bucket: this.bucket(), Key: objectKey }),
      );

      return {
        key: objectKey,
        size: response.ContentLength ?? 0,
        contentType: response.ContentType,
        lastModified: response.LastModified,
      };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw new StorageError(`Failed to head object: ${objectKey}`, error);
    }
  }

  /**
   * EXACTLY one object.
   *
   * B1's reactivation calls this on a LIVE tenant to remove the export artifact while every
   * product image under the same tenant prefix must survive. Never re-implement it as a prefix
   * delete "for symmetry".
   */
  async delete(key: string): Promise<void> {
    const objectKey = this.requireKey(key, 'object key');

    try {
      await this.client().send(
        new DeleteObjectCommand({ Bucket: this.bucket(), Key: objectKey }),
      );
    } catch (error) {
      if (isNotFound(error)) return;
      throw new StorageError(`Failed to delete object: ${objectKey}`, error);
    }
  }

  /**
   * Everything under a prefix. Returns how many objects were removed.
   *
   * DeleteObjects is a PARTIAL-SUCCESS API: it answers 200 and reports per-key failures in an
   * `Errors` array, so the SDK throws nothing when some of the batch survives. Counting the
   * batch as removed — which this did — makes the driver report a clean sweep over objects that
   * are still there. B1's purge is the caller that matters: it would write its audit row, delete
   * the Tenant row, and leave product images fetchable unsigned from the public media prefix,
   * for a merchant whose data the platform had just certified as erased. So the failures are
   * read, and a prefix that did not empty RAISES rather than returning a comfortable number.
   */
  async deleteByPrefix(prefix: string): Promise<number> {
    // An empty prefix means "the whole bucket" — every tenant at once. Refuse it here rather
    // than trusting every future caller to have built the string with tenantPrefix().
    const objectPrefix = this.requireKey(prefix, 'prefix');

    const objects = await this.listAll(objectPrefix);
    if (objects.length === 0) return 0;

    const bucket = this.bucket();
    const failures: string[] = [];
    let removed = 0;

    for (let i = 0; i < objects.length; i += DELETE_BATCH_SIZE) {
      const batch = objects.slice(i, i + DELETE_BATCH_SIZE);
      let response;

      try {
        response = await this.client().send(
          new DeleteObjectsCommand({
            Bucket: bucket,
            // NOT Quiet: quiet mode suppresses the per-key report we are here to read.
            Delete: { Objects: batch.map((object) => ({ Key: object.key })), Quiet: false },
          }),
        );
      } catch (error) {
        throw new StorageError(`Failed to delete objects under prefix: ${objectPrefix}`, error);
      }

      for (const failure of response.Errors ?? []) {
        if (failure.Key) failures.push(failure.Key);
      }
      removed += batch.length - (response.Errors?.length ?? 0);
    }

    if (failures.length > 0) {
      throw new StorageError(
        `Failed to delete ${failures.length} object(s) under prefix ${objectPrefix}: ${failures
          .slice(0, 5)
          .join(', ')}${failures.length > 5 ? ', …' : ''}`,
      );
    }

    return removed;
  }

  async list(prefix: string, limit = LIST_PAGE_SIZE): Promise<StoredObject[]> {
    return this.listAll(prefix, limit);
  }

  private async listAll(prefix: string, limit = Number.MAX_SAFE_INTEGER): Promise<StoredObject[]> {
    const bucket = this.bucket();
    const results: StoredObject[] = [];
    let continuationToken: string | undefined;

    do {
      let response;
      try {
        response = await this.client().send(
          new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: prefix,
            ContinuationToken: continuationToken,
            MaxKeys: Math.min(LIST_PAGE_SIZE, Math.max(1, limit - results.length)),
          }),
        );
      } catch (error) {
        throw new StorageError(`Failed to list objects under prefix: ${prefix}`, error);
      }

      for (const object of response.Contents ?? []) {
        if (!object.Key) continue;
        results.push({
          key: object.Key,
          size: object.Size ?? 0,
          lastModified: object.LastModified,
        });
        if (results.length >= limit) return results;
      }

      continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
    } while (continuationToken);

    return results;
  }

  /**
   * A short-lived signed URL, clamped HERE. The ceiling is not the caller's to raise: see the
   * SigV4 note at the top of this file.
   */
  async signedUrl(key: string, ttlSeconds: number): Promise<string> {
    const objectKey = this.requireKey(key, 'object key');
    const ttl = Math.max(1, Math.min(Math.floor(ttlSeconds), MAX_SIGNED_URL_TTL_SECONDS));

    try {
      return await getSignedUrl(
        this.client(),
        new GetObjectCommand({ Bucket: this.bucket(), Key: objectKey }),
        { expiresIn: ttl },
      );
    } catch (error) {
      throw new StorageError(`Failed to sign a URL for: ${objectKey}`, error);
    }
  }

  /**
   * The public CDN URL for a MEDIA object.
   *
   * Throws for anything outside the media segment. The CDN origin is restricted to `media/` and
   * an export artifact must never be fetchable unsigned — so a caller that accidentally hands an
   * export key to a template gets an exception here rather than a public link to a merchant's
   * entire catalogue.
   */
  publicUrl(key: string): string {
    if (!isMediaKey(key)) {
      throw new StorageError(
        `Refusing a public URL for a non-media key: ${key}. The CDN origin is restricted to the media segment.`,
      );
    }

    const base = this.publicBaseOverride ?? getEnv().CDN_PUBLIC_BASE_URL;
    if (!base) {
      // Falling back to the app server here would quietly break invariant 4 in production, and
      // it would look like it worked.
      throw new StorageError(
        'CDN_PUBLIC_BASE_URL is not set. Media is always delivered by the CDN in front of R2.',
      );
    }

    /**
     * The base must be an ABSOLUTE origin, and the check is worth its three lines.
     *
     * `CDN_PUBLIC_BASE_URL=cdn.souqbartaa.com` — a missing scheme, the most ordinary deploy typo
     * there is — produced `cdn.souqbartaa.com/tenants/…`, which every `<img src>` on every
     * storefront resolves as a RELATIVE path against the shop's own hostname. The browser then
     * asks the app container for `https://{shop}.{DOMAIN}/cdn.souqbartaa.com/tenants/…`, which
     * 404s. No exception, no log line: just broken images everywhere and every image request
     * landing on the origin the CDN exists to protect.
     */
    if (!/^https?:\/\//i.test(base)) {
      throw new StorageError(
        `CDN_PUBLIC_BASE_URL must be an absolute http(s) origin; got "${base}". Without a scheme every media URL resolves against the storefront's own hostname.`,
      );
    }

    return `${base.replace(/\/+$/, '')}/${key}`;
  }
}
