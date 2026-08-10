import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetEnvCache } from '@/env';
import { R2StorageAdapter, SIGV4_MAX_TTL_SECONDS } from '@/server/media/storage';
import { MAX_SIGNED_URL_TTL_SECONDS, StorageError, exportsPrefix, mediaPrefix } from '@/server/storage';

/**
 * A3 — the R2 driver against the S3 client's behaviour.
 *
 * There is no bucket and no network in this environment, so the driver is exercised against an
 * in-memory fake that answers the real command objects. What that buys is specific and worth
 * naming: these assertions are NOT driver-agnostic. They check the COMMANDS the driver issues —
 * that a prefix delete pages and batches, that a single delete sends exactly one key, that
 * encryption is requested for an export and not for a product photo. The semantics those
 * commands add up to are re-checked against a real filesystem in `a3-storage-local.test.ts`.
 *
 * `signedUrl` is the one thing tested for real: SigV4 presigning is pure arithmetic over the
 * client's credentials, so it works offline and the clamp is measured on the actual URL.
 */

const BUCKET = 'souq-test';
const TENANT = 'tnt_r2';

interface FakeObject {
  body: Buffer;
  contentType?: string;
  cacheControl?: string;
  contentDisposition?: string;
  sse?: string;
  lastModified: Date;
}

let bucket: Map<string, FakeObject>;
let client: S3Client;
let sent: unknown[];
let adapter: R2StorageAdapter;
/** Keys the fake bucket refuses to delete, so a partial failure can be exercised. */
let undeletableKeys: Set<string>;

class NotFound extends Error {
  readonly $metadata = { httpStatusCode: 404 };
  constructor() {
    super('NotFound');
    this.name = 'NotFound';
  }
}

function handle(command: unknown): unknown {
  if (command instanceof PutObjectCommand) {
    const input = command.input;
    bucket.set(String(input.Key), {
      body: Buffer.from(input.Body as Uint8Array),
      contentType: input.ContentType,
      cacheControl: input.CacheControl,
      contentDisposition: input.ContentDisposition,
      sse: input.ServerSideEncryption,
      lastModified: new Date(),
    });
    return {};
  }

  if (command instanceof GetObjectCommand) {
    const object = bucket.get(String(command.input.Key));
    if (!object) throw new NotFound();
    return { Body: { transformToByteArray: async () => new Uint8Array(object.body) } };
  }

  if (command instanceof HeadObjectCommand) {
    const object = bucket.get(String(command.input.Key));
    if (!object) throw new NotFound();
    return {
      ContentLength: object.body.byteLength,
      ContentType: object.contentType,
      LastModified: object.lastModified,
    };
  }

  if (command instanceof DeleteObjectCommand) {
    bucket.delete(String(command.input.Key));
    return {};
  }

  if (command instanceof DeleteObjectsCommand) {
    /**
     * DeleteObjects is a PARTIAL-SUCCESS API: it answers 200 and reports per-key failures in an
     * `Errors` array rather than throwing. The fake models that, because it is the behaviour the
     * driver has to survive — B1's purge certifies a tenant's data as erased on the strength of
     * this call's return value.
     */
    const deleted: Array<{ Key: string }> = [];
    const errors: Array<{ Key: string; Code: string; Message: string }> = [];

    for (const object of command.input.Delete?.Objects ?? []) {
      const key = String(object.Key);
      if (undeletableKeys.has(key)) {
        errors.push({ Key: key, Code: 'AccessDenied', Message: 'refused by a lifecycle rule' });
        continue;
      }
      bucket.delete(key);
      deleted.push({ Key: key });
    }

    return errors.length ? { Deleted: deleted, Errors: errors } : { Deleted: deleted };
  }

  if (command instanceof ListObjectsV2Command) {
    const { Prefix = '', MaxKeys = 1_000, ContinuationToken } = command.input;
    const keys = [...bucket.keys()].filter((key) => key.startsWith(Prefix)).sort();
    const start = ContinuationToken ? keys.indexOf(ContinuationToken) : 0;
    const page = keys.slice(start, start + MaxKeys);
    const next = keys[start + page.length];

    return {
      Contents: page.map((key) => ({
        Key: key,
        Size: bucket.get(key)!.body.byteLength,
        LastModified: bucket.get(key)!.lastModified,
      })),
      IsTruncated: Boolean(next),
      NextContinuationToken: next,
    };
  }

  throw new Error(`unexpected command: ${(command as object).constructor.name}`);
}

beforeEach(() => {
  bucket = new Map();
  sent = [];
  undeletableKeys = new Set();

  client = new S3Client({
    region: 'auto',
    endpoint: 'https://account.r2.cloudflarestorage.test',
    forcePathStyle: true,
    credentials: { accessKeyId: 'test-key', secretAccessKey: 'test-secret' },
  });

  vi.spyOn(client, 'send').mockImplementation((async (command: unknown) => {
    sent.push(command);
    return handle(command);
  }) as never);

  adapter = new R2StorageAdapter({
    client,
    bucket: BUCKET,
    publicBaseUrl: 'https://cdn.souqbartaa.test',
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('put', () => {
  it('sends the bucket, key, content type and cache control', async () => {
    const key = `${mediaPrefix(TENANT)}m1/full.webp`;
    const stored = await adapter.put(key, Buffer.from('image-bytes'), {
      contentType: 'image/webp',
      cacheControl: 'public, max-age=31536000, immutable',
    });

    expect(stored).toMatchObject({ key, size: 11, contentType: 'image/webp' });

    const command = sent[0] as PutObjectCommand;
    expect(command).toBeInstanceOf(PutObjectCommand);
    expect(command.input.Bucket).toBe(BUCKET);
    expect(command.input.CacheControl).toBe('public, max-age=31536000, immutable');
    // A product photo is public by design; encrypting it at rest buys nothing and costs a header.
    expect(command.input.ServerSideEncryption).toBeUndefined();
  });

  it('requests server-side encryption when the caller asks for it', async () => {
    await adapter.put(`${exportsPrefix(TENANT)}artifact.zip`, Buffer.from('catalogue'), {
      encrypt: true,
      contentType: 'application/zip',
      contentDisposition: 'attachment',
    });

    const command = sent[0] as PutObjectCommand;
    expect(command.input.ServerSideEncryption).toBe('AES256');
    expect(command.input.ContentDisposition).toBe('attachment');
  });

  it('refuses an empty key', async () => {
    await expect(adapter.put('  ', Buffer.from('x'))).rejects.toBeInstanceOf(StorageError);
  });
});

describe('get / head', () => {
  it('round-trips bytes', async () => {
    const key = `${mediaPrefix(TENANT)}m1/full.webp`;
    await adapter.put(key, Buffer.from('round-trip'));
    expect((await adapter.get(key)).toString()).toBe('round-trip');
  });

  it('turns a 404 into null from head() and an error from get()', async () => {
    const missing = `${mediaPrefix(TENANT)}nope/full.webp`;
    expect(await adapter.head(missing)).toBeNull();
    expect(await adapter.exists(missing)).toBe(false);
    await expect(adapter.get(missing)).rejects.toBeInstanceOf(StorageError);
  });
});

describe('delete versus deleteByPrefix', () => {
  it('delete() sends ONE DeleteObjectCommand and leaves the rest of the prefix alone', async () => {
    await adapter.put(`${mediaPrefix(TENANT)}m1/full.webp`, Buffer.from('a'));
    await adapter.put(`${mediaPrefix(TENANT)}m2/full.webp`, Buffer.from('b'));
    const artifact = `${exportsPrefix(TENANT)}artifact.zip`;
    await adapter.put(artifact, Buffer.from('c'));

    sent.length = 0;
    await adapter.delete(artifact);

    expect(sent).toHaveLength(1);
    expect(sent[0]).toBeInstanceOf(DeleteObjectCommand);
    expect([...bucket.keys()].sort()).toEqual([
      `${mediaPrefix(TENANT)}m1/full.webp`,
      `${mediaPrefix(TENANT)}m2/full.webp`,
    ]);
  });

  it('deleteByPrefix removes everything under the prefix and reports the count', async () => {
    for (let i = 0; i < 5; i += 1) {
      await adapter.put(`${mediaPrefix(TENANT)}m${i}/full.webp`, Buffer.from(String(i)));
    }
    await adapter.put(`${exportsPrefix(TENANT)}artifact.zip`, Buffer.from('x'));
    await adapter.put('tenants/other/media/m0/full.webp', Buffer.from('other'));

    const removed = await adapter.deleteByPrefix(`tenants/${TENANT}/`);

    expect(removed).toBe(6);
    expect([...bucket.keys()]).toEqual(['tenants/other/media/m0/full.webp']);
  });

  it('pages the listing and batches the deletes at the S3 limit of 1000', async () => {
    for (let i = 0; i < 1_500; i += 1) {
      bucket.set(`tenants/${TENANT}/media/m${String(i).padStart(5, '0')}/full.webp`, {
        body: Buffer.from('x'),
        lastModified: new Date(),
      });
    }

    sent.length = 0;
    const removed = await adapter.deleteByPrefix(`tenants/${TENANT}/`);

    expect(removed).toBe(1_500);
    const deleteCommands = sent.filter((c) => c instanceof DeleteObjectsCommand);
    expect(deleteCommands).toHaveLength(2);
    for (const command of deleteCommands as DeleteObjectsCommand[]) {
      expect(command.input.Delete?.Objects?.length).toBeLessThanOrEqual(1_000);
    }
    expect(bucket.size).toBe(0);
  });

  it('REFUSES an empty prefix — that would be the whole bucket, every tenant at once', async () => {
    await adapter.put(`${mediaPrefix(TENANT)}m1/full.webp`, Buffer.from('a'));
    await expect(adapter.deleteByPrefix('')).rejects.toBeInstanceOf(StorageError);
    expect(bucket.size).toBe(1);
  });

  /**
   * The guarantee B1's purge is built on, and the one a green gate could not see.
   *
   * DeleteObjects answers 200 with a per-key `Errors` array when some of a batch survives, so the
   * SDK throws nothing. Counting the batch as removed meant the driver reported a clean sweep over
   * objects that are still there: the purge would write its audit row, delete the Tenant row, and
   * leave product images fetchable unsigned from the public media prefix for a merchant whose data
   * the platform had just certified as erased.
   */
  it('RAISES when R2 refuses part of a batch, instead of reporting a clean sweep', async () => {
    const survivor = `${mediaPrefix(TENANT)}m2/full.webp`;
    await adapter.put(`${mediaPrefix(TENANT)}m1/full.webp`, Buffer.from('a'));
    await adapter.put(survivor, Buffer.from('b'));
    await adapter.put(`${mediaPrefix(TENANT)}m3/full.webp`, Buffer.from('c'));
    undeletableKeys.add(survivor);

    let thrown: unknown;
    try {
      await adapter.deleteByPrefix(`tenants/${TENANT}/`);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(StorageError);
    // The message has to name what survived: "some objects remain" is not actionable at 03:00.
    expect((thrown as StorageError).message).toContain(survivor);
    expect(bucket.has(survivor)).toBe(true);
  });

  it('asks for the per-key report rather than suppressing it with Quiet', async () => {
    await adapter.put(`${mediaPrefix(TENANT)}m1/full.webp`, Buffer.from('a'));
    sent.length = 0;
    await adapter.deleteByPrefix(`tenants/${TENANT}/`);

    const [command] = sent.filter((c) => c instanceof DeleteObjectsCommand) as DeleteObjectsCommand[];
    // Quiet mode suppresses exactly the `Errors` array the check above depends on.
    expect(command?.input.Delete?.Quiet).toBe(false);
  });
});

describe('list', () => {
  it('honours the limit', async () => {
    for (let i = 0; i < 10; i += 1) {
      await adapter.put(`${mediaPrefix(TENANT)}m${i}/full.webp`, Buffer.from('x'));
    }

    expect(await adapter.list(mediaPrefix(TENANT), 4)).toHaveLength(4);
    expect(await adapter.list(mediaPrefix(TENANT), 100)).toHaveLength(10);
  });
});

describe('publicUrl', () => {
  it('serves a media key from the CDN origin', () => {
    const key = `${mediaPrefix(TENANT)}m1/full.webp`;
    expect(adapter.publicUrl(key)).toBe(`https://cdn.souqbartaa.test/${key}`);
  });

  it('REFUSES an export key', () => {
    expect(() => adapter.publicUrl(`${exportsPrefix(TENANT)}artifact.zip`)).toThrow(StorageError);
  });

  it('refuses to fall back to the app server when no CDN origin is configured', () => {
    // Falling back would break invariant 4 in production and look like it worked.
    const unconfigured = new R2StorageAdapter({ client, bucket: BUCKET });
    expect(() => unconfigured.publicUrl(`${mediaPrefix(TENANT)}m1/full.webp`)).toThrow(StorageError);
  });
});

describe('signedUrl', () => {
  it('presigns with SigV4 and clamps the TTL to the platform ceiling', async () => {
    const key = `${exportsPrefix(TENANT)}artifact.zip`;
    const url = new URL(await adapter.signedUrl(key, 30 * 24 * 3_600));

    expect(url.searchParams.get('X-Amz-Expires')).toBe(String(MAX_SIGNED_URL_TTL_SECONDS));
    expect(url.searchParams.get('X-Amz-Signature')).toBeTruthy();
    expect(url.pathname).toContain(key);
  });

  it('signs the key it was given, so one signature does not open a neighbour', async () => {
    const a = new URL(await adapter.signedUrl(`${exportsPrefix(TENANT)}a.zip`, 600));
    const b = new URL(await adapter.signedUrl(`${exportsPrefix(TENANT)}b.zip`, 600));

    expect(a.pathname).not.toBe(b.pathname);
    expect(a.searchParams.get('X-Amz-Signature')).not.toBe(b.searchParams.get('X-Amz-Signature'));
  });

  it('states the hard SigV4 ceiling well above what it will ever mint', () => {
    // 7 days is the protocol's limit; the platform's own limit is an hour. Q18's 30-day promise
    // is kept by a revocable platform route, and this constant is the reason why.
    expect(SIGV4_MAX_TTL_SECONDS).toBe(604_800);
    expect(MAX_SIGNED_URL_TTL_SECONDS).toBeLessThan(SIGV4_MAX_TTL_SECONDS);
  });
});

describe('failures that are NOT "the object is absent"', () => {
  /**
   * A 404 is not one fact. `NoSuchBucket` also arrives as 404, and folding it into "not found"
   * turns a configuration mistake into a permanent lie: `process-upload` asks `exists()` before it
   * decides whether a source is genuinely gone, so a web container writing to one bucket and a
   * worker reading from another marks every upload `sourceMissing` — never retried, and the
   * merchant is told «ما لقينا ملف الصورة الأصلي» about an object sitting safely in the other
   * bucket. On a fresh deploy with a typo in R2_BUCKET that is 100% of uploads.
   */
  class NoSuchBucket extends Error {
    readonly $metadata = { httpStatusCode: 404 };
    constructor() {
      super('The specified bucket does not exist');
      this.name = 'NoSuchBucket';
    }
  }

  it('reports a missing BUCKET as an error, not as a missing object', async () => {
    vi.spyOn(client, 'send').mockImplementation((async () => {
      throw new NoSuchBucket();
    }) as never);

    await expect(adapter.head(`${mediaPrefix(TENANT)}m1/full.webp`)).rejects.toBeInstanceOf(
      StorageError,
    );
    await expect(adapter.exists(`${mediaPrefix(TENANT)}m1/full.webp`)).rejects.toBeInstanceOf(
      StorageError,
    );
  });

  it('still reports a genuinely missing object as absent', async () => {
    expect(await adapter.head(`${mediaPrefix(TENANT)}nothing/full.webp`)).toBeNull();
    expect(await adapter.exists(`${mediaPrefix(TENANT)}nothing/full.webp`)).toBe(false);
  });
});

describe('configuration that must fail loudly', () => {
  it('refuses an unsupported R2_SSE_ALGORITHM, naming the variable', async () => {
    const previous = process.env.R2_SSE_ALGORITHM;
    process.env.R2_SSE_ALGORITHM = 'AES-256'; // the plausible typo for AES256
    resetEnvCache();

    try {
      let thrown: unknown;
      try {
        await adapter.put(`${exportsPrefix(TENANT)}artifact.zip`, Buffer.from('catalogue'), {
          encrypt: true,
        });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(StorageError);
      expect((thrown as StorageError).message).toContain('R2_SSE_ALGORITHM');
      // It must fail BEFORE the write, not emit an unusable header and let R2 answer 400 on the
      // one artifact whose loss is unrecoverable.
      expect(bucket.size).toBe(0);
    } finally {
      if (previous === undefined) delete process.env.R2_SSE_ALGORITHM;
      else process.env.R2_SSE_ALGORITHM = previous;
      resetEnvCache();
    }
  });

  it('refuses a CDN base with no scheme, which would resolve against the storefront', () => {
    // `cdn.souqbartaa.com` without https:// makes every <img src> a RELATIVE path, so every image
    // request lands on the app container as a 404 — with no exception and no log line.
    const relative = new R2StorageAdapter({
      client,
      bucket: BUCKET,
      publicBaseUrl: 'cdn.souqbartaa.test',
    });

    expect(() => relative.publicUrl(`${mediaPrefix(TENANT)}m1/full.webp`)).toThrow(
      /CDN_PUBLIC_BASE_URL/,
    );
  });
});
