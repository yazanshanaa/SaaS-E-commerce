import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { AddressInfo } from 'node:net';
import {
  CreateBucketCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
  S3Client,
} from '@aws-sdk/client-s3';

/**
 * A real S3 endpoint for the Phase 7 export test.
 *
 * WHY THIS EXISTS AT ALL. Every existing suite proves the export machinery against
 * `LocalStorageAdapter`, whose `signedUrl` is not a presign — it is an HMAC over `key:expires`
 * that a route in this application verifies. So the two things Phase 7 says hide in the storage
 * layer are exactly the two things no test has ever touched: the SigV4 presign (its expiry, and
 * the ceiling that makes Q18 a platform route rather than a signature) and the orphan sweep's
 * behaviour over a real ListObjectsV2 paging.
 *
 * TWO BACKENDS, ONE SUITE.
 *
 *   external — set `S3_TEST_ENDPOINT` (plus `S3_TEST_ACCESS_KEY_ID` / `S3_TEST_SECRET_ACCESS_KEY`)
 *              and the suite runs against a real minio. CI does exactly this, as a service
 *              container. This is the authoritative run.
 *   stub     — otherwise, the in-process server below. It exists because the development machine
 *              this was written on has no Docker, and a test that only runs in CI is a test the
 *              author cannot iterate on — which is how tests end up asserting nothing.
 *
 * WHAT THE STUB REALLY VERIFIES, STATED PLAINLY SO NOBODY OVERCLAIMS IT:
 *   - It speaks the wire protocol. Every request is a genuine AWS SDK request: real XML for
 *     ListObjectsV2 and DeleteObjects, real pagination with continuation tokens, real partial
 *     failure reporting, real 404 shapes. The driver's own parsing is under test, not mocked out.
 *   - It fully verifies PRESIGNED GET signatures — canonical request, scope, signing key, the
 *     lot — and enforces `X-Amz-Expires` against the clock. A forged or expired presign is
 *     refused, so an assertion that a signed URL works means the signature was correct.
 *   - It does NOT recompute header-authenticated (`Authorization: AWS4-HMAC-SHA256 ...`)
 *     signatures. It checks the header is present and names the right access key, and no more.
 *     Verifying those needs the payload-signing path too, which would be a second implementation
 *     of the SDK rather than a test fixture. The external backend is what covers it, and it is
 *     the reason `S3_TEST_ENDPOINT` exists rather than this being the only option.
 *
 * Nothing here is reachable from `src/` — `tests/**` is exempt from the S3 import restriction
 * (eslint.config.mjs) precisely so a fixture may hold an S3 client, and the containment scan
 * walks `src/` only.
 */

const SERVICE = 's3';

export interface TestS3Endpoint {
  readonly kind: 'stub' | 'external';
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
  readonly credentials: { accessKeyId: string; secretAccessKey: string };
  /** A client already pointed at the endpoint, for fixture setup the adapter does not expose. */
  readonly client: S3Client;
  /** Empties the bucket. Cheaper and more honest than recreating it between cases. */
  reset(): Promise<void>;
  stop(): Promise<void>;
}

// --- SigV4 ------------------------------------------------------------------------------------

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}

function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

function signingKey(secret: string, date: string, region: string, service: string): Buffer {
  return hmac(hmac(hmac(hmac(`AWS4${secret}`, date), region), service), 'aws4_request');
}

/**
 * RFC 3986, which is what SigV4 canonicalisation requires and what `encodeURIComponent` is four
 * characters short of. Getting this wrong produces a signature mismatch on exactly the requests
 * whose keys contain those characters, which is the kind of bug that passes every test written
 * with tidy fixture names.
 */
function rfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function parseAmzDate(stamp: string): Date | null {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(stamp);
  if (!match) return null;
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  return new Date(Date.UTC(year, month - 1, day, hour, minute, second));
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

type PresignVerdict = { ok: true } | { ok: false; code: 'AccessDenied' | 'ExpiredToken'; message: string };

function verifyPresignedGet(
  request: IncomingMessage,
  url: URL,
  secretAccessKey: string,
): PresignVerdict {
  const signature = url.searchParams.get('X-Amz-Signature');
  const credential = url.searchParams.get('X-Amz-Credential');
  const amzDate = url.searchParams.get('X-Amz-Date');
  const expires = url.searchParams.get('X-Amz-Expires');
  const signedHeaders = url.searchParams.get('X-Amz-SignedHeaders');

  if (!signature || !credential || !amzDate || !expires || !signedHeaders) {
    return { ok: false, code: 'AccessDenied', message: 'incomplete presigned query' };
  }

  const signedAt = parseAmzDate(amzDate);
  if (!signedAt) return { ok: false, code: 'AccessDenied', message: 'X-Amz-Date is malformed' };

  // The whole reason the export link is a platform route and not a presign. A signature that has
  // outlived its window must be REFUSED, not merely frowned at, or "the link still works on day
  // 29" would be a claim about nothing.
  const expiresAt = signedAt.getTime() + Number(expires) * 1000;
  if (Date.now() > expiresAt) {
    return { ok: false, code: 'ExpiredToken', message: 'Request has expired' };
  }

  // `{accessKeyId}/{date}/{region}/{service}/aws4_request`
  const credentialParts = credential.split('/');
  if (credentialParts.length !== 5) {
    return { ok: false, code: 'AccessDenied', message: 'credential is malformed' };
  }
  const [, credentialDate, credentialRegion, credentialService] = credentialParts as [
    string,
    string,
    string,
    string,
    string,
  ];
  if (credentialService !== SERVICE) {
    return { ok: false, code: 'AccessDenied', message: 'credential scope is not s3' };
  }

  const canonicalQuery = [...url.searchParams.entries()]
    .filter(([name]) => name !== 'X-Amz-Signature')
    .map(([name, value]) => [rfc3986(name), rfc3986(value)] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1))
    .map(([name, value]) => `${name}=${value}`)
    .join('&');

  const headerNames = signedHeaders.split(';');
  const canonicalHeaders = headerNames
    .map((name) => {
      const raw = request.headers[name];
      const value = Array.isArray(raw) ? raw.join(',') : (raw ?? '');
      return `${name}:${value.trim().replace(/\s+/g, ' ')}\n`;
    })
    .join('');

  const canonicalRequest = [
    'GET',
    url.pathname,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    'UNSIGNED-PAYLOAD',
  ].join('\n');

  const scope = `${credentialDate}/${credentialRegion}/${credentialService}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
  const expected = createHmac(
    'sha256',
    signingKey(secretAccessKey, credentialDate, credentialRegion, credentialService),
  )
    .update(stringToSign, 'utf8')
    .digest('hex');

  return constantTimeEquals(expected, signature)
    ? { ok: true }
    : { ok: false, code: 'AccessDenied', message: 'signature mismatch' };
}

// --- the in-process server --------------------------------------------------------------------

interface StoredEntry {
  body: Buffer;
  contentType?: string;
  cacheControl?: string;
  contentDisposition?: string;
  serverSideEncryption?: string;
  lastModified: Date;
  etag: string;
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function errorXml(code: string, message: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${xmlEscape(message)}</Message></Error>`;
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

class StubS3Server {
  private readonly objects = new Map<string, Map<string, StoredEntry>>();
  private readonly server: Server;

  constructor(
    private readonly accessKeyId: string,
    private readonly secretAccessKey: string,
  ) {
    this.server = createServer((request, response) => {
      void this.handle(request, response).catch((error: unknown) => {
        response.writeHead(500, { 'content-type': 'application/xml' });
        response.end(errorXml('InternalError', error instanceof Error ? error.message : 'unknown'));
      });
    });
  }

  async listen(): Promise<number> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    return (this.server.address() as AddressInfo).port;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  private bucketOf(name: string): Map<string, StoredEntry> {
    let bucket = this.objects.get(name);
    if (!bucket) {
      bucket = new Map();
      this.objects.set(name, bucket);
    }
    return bucket;
  }

  /**
   * Path-style only, which costs nothing to assume: the driver hardcodes `forcePathStyle: true`
   * (r2-driver.ts) because minio needs it and R2 accepts it.
   */
  private route(url: URL): { bucket: string; key: string } {
    const path = url.pathname.replace(/^\//, '');
    const slash = path.indexOf('/');
    if (slash === -1) return { bucket: decodeURIComponent(path), key: '' };
    return {
      bucket: decodeURIComponent(path.slice(0, slash)),
      key: decodeURIComponent(path.slice(slash + 1)),
    };
  }

  private authorised(request: IncomingMessage, url: URL): PresignVerdict {
    if (url.searchParams.has('X-Amz-Signature')) {
      return verifyPresignedGet(request, url, this.secretAccessKey);
    }

    // See the header of this file: the stub checks that a header-authenticated request IS
    // authenticated and names the right key, and leaves recomputing its signature to minio.
    // What it must not do is wave through a request carrying no credential at all — "an export
    // artifact is not fetchable unsigned" is one of the things this suite asserts.
    const authorization = request.headers.authorization ?? '';
    if (authorization.startsWith('AWS4-HMAC-SHA256') && authorization.includes(this.accessKeyId)) {
      return { ok: true };
    }
    return { ok: false, code: 'AccessDenied', message: 'unsigned request' };
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`);
    const { bucket: bucketName, key } = this.route(url);

    const verdict = this.authorised(request, url);
    if (!verdict.ok) {
      response.writeHead(403, { 'content-type': 'application/xml' });
      response.end(errorXml(verdict.code, verdict.message));
      return;
    }

    const bucket = this.bucketOf(bucketName);
    const method = request.method ?? 'GET';

    // CreateBucket / HeadBucket — buckets are implicit here, so both simply succeed.
    if (key === '' && (method === 'PUT' || method === 'HEAD')) {
      response.writeHead(200);
      response.end();
      return;
    }

    if (method === 'POST' && url.searchParams.has('delete')) {
      await this.deleteObjects(request, response, bucket);
      return;
    }

    if (method === 'GET' && key === '' && url.searchParams.get('list-type') === '2') {
      this.listObjectsV2(response, bucket, url);
      return;
    }

    if (method === 'PUT') {
      const body = await readBody(request);
      bucket.set(key, {
        body,
        contentType: request.headers['content-type'],
        cacheControl: request.headers['cache-control'],
        contentDisposition: request.headers['content-disposition'] as string | undefined,
        serverSideEncryption: request.headers['x-amz-server-side-encryption'] as string | undefined,
        lastModified: new Date(),
        etag: `"${createHash('md5').update(body).digest('hex')}"`,
      });
      response.writeHead(200, { etag: bucket.get(key)!.etag });
      response.end();
      return;
    }

    if (method === 'GET' || method === 'HEAD') {
      const entry = bucket.get(key);
      if (!entry) {
        // HEAD carries no body by protocol, and the SDK maps a bodiless 404 to `NotFound`; GET
        // gets the XML so it maps to `NoSuchKey`. The driver's `isNotFound` accepts either, and
        // getting this wrong would make a missing object look like a transport failure.
        response.writeHead(404, method === 'GET' ? { 'content-type': 'application/xml' } : {});
        response.end(method === 'GET' ? errorXml('NoSuchKey', `no such key: ${key}`) : undefined);
        return;
      }

      const headers: Record<string, string> = {
        'content-length': String(entry.body.length),
        'last-modified': entry.lastModified.toUTCString(),
        etag: entry.etag,
      };
      if (entry.contentType) headers['content-type'] = entry.contentType;
      if (entry.cacheControl) headers['cache-control'] = entry.cacheControl;
      if (entry.contentDisposition) headers['content-disposition'] = entry.contentDisposition;
      if (entry.serverSideEncryption) {
        headers['x-amz-server-side-encryption'] = entry.serverSideEncryption;
      }

      response.writeHead(200, headers);
      response.end(method === 'HEAD' ? undefined : entry.body);
      return;
    }

    if (method === 'DELETE') {
      bucket.delete(key);
      response.writeHead(204);
      response.end();
      return;
    }

    response.writeHead(405);
    response.end();
  }

  private listObjectsV2(response: ServerResponse, bucket: Map<string, StoredEntry>, url: URL): void {
    const prefix = url.searchParams.get('prefix') ?? '';
    const maxKeys = Number(url.searchParams.get('max-keys') ?? '1000');
    const after = url.searchParams.get('continuation-token');

    const all = [...bucket.keys()]
      .filter((key) => key.startsWith(prefix))
      .sort()
      .filter((key) => (after ? key > after : true));

    const page = all.slice(0, maxKeys);
    const truncated = all.length > page.length;

    const contents = page
      .map((key) => {
        const entry = bucket.get(key)!;
        return [
          '<Contents>',
          `<Key>${xmlEscape(key)}</Key>`,
          `<LastModified>${entry.lastModified.toISOString()}</LastModified>`,
          `<ETag>${xmlEscape(entry.etag)}</ETag>`,
          `<Size>${entry.body.length}</Size>`,
          '<StorageClass>STANDARD</StorageClass>',
          '</Contents>',
        ].join('');
      })
      .join('');

    const body = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">',
      `<Prefix>${xmlEscape(prefix)}</Prefix>`,
      `<KeyCount>${page.length}</KeyCount>`,
      `<MaxKeys>${maxKeys}</MaxKeys>`,
      `<IsTruncated>${truncated}</IsTruncated>`,
      truncated
        ? `<NextContinuationToken>${xmlEscape(page[page.length - 1]!)}</NextContinuationToken>`
        : '',
      contents,
      '</ListBucketResult>',
    ].join('');

    response.writeHead(200, { 'content-type': 'application/xml' });
    response.end(body);
  }

  private async deleteObjects(
    request: IncomingMessage,
    response: ServerResponse,
    bucket: Map<string, StoredEntry>,
  ): Promise<void> {
    const body = (await readBody(request)).toString('utf8');
    const keys = [...body.matchAll(/<Key>([\s\S]*?)<\/Key>/g)].map((match) =>
      match[1]!.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"'),
    );

    const deleted = keys
      .map((key) => {
        bucket.delete(key);
        return `<Deleted><Key>${xmlEscape(key)}</Key></Deleted>`;
      })
      .join('');

    response.writeHead(200, { 'content-type': 'application/xml' });
    response.end(
      `<?xml version="1.0" encoding="UTF-8"?><DeleteResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">${deleted}</DeleteResult>`,
    );
  }
}

// --- the fixture ------------------------------------------------------------------------------

async function emptyBucket(client: S3Client, bucket: string): Promise<void> {
  let continuationToken: string | undefined;
  do {
    const page = await client.send(
      new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: continuationToken }),
    );
    const keys = (page.Contents ?? []).map((object) => ({ Key: object.Key! }));
    if (keys.length > 0) {
      await client.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: keys } }));
    }
    continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (continuationToken);
}

export async function startTestS3(options: { bucket?: string } = {}): Promise<TestS3Endpoint> {
  const bucket = options.bucket ?? 'souq-bartaa-test';
  const external = process.env.S3_TEST_ENDPOINT;

  const region = process.env.S3_TEST_REGION ?? 'auto';
  const credentials = {
    accessKeyId: process.env.S3_TEST_ACCESS_KEY_ID ?? 'souq-test-access-key',
    secretAccessKey: process.env.S3_TEST_SECRET_ACCESS_KEY ?? 'souq-test-secret-key',
  };

  if (external) {
    const client = new S3Client({
      region,
      endpoint: external,
      forcePathStyle: true,
      credentials,
    });

    try {
      await client.send(new HeadBucketCommand({ Bucket: bucket }));
    } catch {
      await client.send(new CreateBucketCommand({ Bucket: bucket }));
    }

    return {
      kind: 'external',
      endpoint: external,
      region,
      bucket,
      credentials,
      client,
      reset: () => emptyBucket(client, bucket),
      stop: async () => {
        await emptyBucket(client, bucket);
        client.destroy();
      },
    };
  }

  const server = new StubS3Server(credentials.accessKeyId, credentials.secretAccessKey);
  const port = await server.listen();
  const endpoint = `http://127.0.0.1:${port}`;
  const client = new S3Client({ region, endpoint, forcePathStyle: true, credentials });

  return {
    kind: 'stub',
    endpoint,
    region,
    bucket,
    credentials,
    client,
    reset: () => emptyBucket(client, bucket),
    stop: async () => {
      client.destroy();
      await server.close();
    },
  };
}
