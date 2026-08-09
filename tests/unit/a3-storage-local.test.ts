import { createHmac } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { getEnv } from '@/env';
import {
  LocalStorageAdapter,
  MAX_SIGNED_URL_TTL_SECONDS,
  StorageError,
  exportsPrefix,
  isExportKey,
  mediaPrefix,
  tenantPrefix,
} from '@/server/storage';

/**
 * A3 — the storage SEMANTICS, exercised against a real filesystem.
 *
 * These assertions are DRIVER-AGNOSTIC: prefix delete versus single delete, TTL clamping, and
 * the publicUrl refusal are contract, not implementation, and `tests/unit/a3-r2-driver.test.ts`
 * re-checks each of them against the S3 command stream. Running them here as well is deliberate:
 * this driver touches a real disk, so "delete removed exactly one thing" is measured rather than
 * asserted about a mock.
 */

let root: string;
let adapter: LocalStorageAdapter;

const TENANT = 'tnt_local';

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'souq-a3-local-'));
  adapter = new LocalStorageAdapter(root);
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

afterEach(() => {
  vi.useRealTimers();
});

async function seedTenant(): Promise<void> {
  await adapter.put(`${mediaPrefix(TENANT)}a1/full.webp`, Buffer.from('one'));
  await adapter.put(`${mediaPrefix(TENANT)}a1/card.webp`, Buffer.from('two'));
  await adapter.put(`${mediaPrefix(TENANT)}a2/full.webp`, Buffer.from('three'));
  await adapter.put(`${exportsPrefix(TENANT)}sub_1-2026-08-10.zip`, Buffer.from('a whole business'));
}

describe('the local driver reads back what it wrote', () => {
  it('stores, heads and gets an object', async () => {
    const key = `${mediaPrefix('tnt_rw')}m1/full.webp`;
    const stored = await adapter.put(key, Buffer.from('hello'));

    expect(stored.size).toBe(5);
    expect(await adapter.exists(key)).toBe(true);
    expect((await adapter.head(key))?.size).toBe(5);
    expect((await adapter.get(key)).toString()).toBe('hello');
  });

  it('reports a missing object as absent rather than throwing from head()', async () => {
    expect(await adapter.head('tenants/nobody/media/x/full.webp')).toBeNull();
    expect(await adapter.exists('tenants/nobody/media/x/full.webp')).toBe(false);
  });

  it('refuses a key that would climb out of the storage root', async () => {
    await expect(adapter.put('../escape.txt', Buffer.from('x'))).rejects.toBeInstanceOf(StorageError);
  });
});

describe('delete(key) versus deleteByPrefix(prefix)', () => {
  it('deleteByPrefix removes EVERY object under a tenant prefix', async () => {
    const tenant = 'tnt_purge';
    await adapter.put(`${mediaPrefix(tenant)}a/full.webp`, Buffer.from('1'));
    await adapter.put(`${mediaPrefix(tenant)}b/thumb.avif`, Buffer.from('2'));
    await adapter.put(`${exportsPrefix(tenant)}artifact.zip`, Buffer.from('3'));

    const removed = await adapter.deleteByPrefix(tenantPrefix(tenant));

    expect(removed).toBe(3);
    expect(await adapter.list(tenantPrefix(tenant))).toHaveLength(0);
  });

  it('delete(key) removes EXACTLY one object and leaves the prefix intact', async () => {
    // B1's reactivation deletes the export artifact of a LIVE tenant. If this were emulated with
    // a prefix delete, every product image the merchant owns would go with it.
    await seedTenant();
    const artifactKey = `${exportsPrefix(TENANT)}sub_1-2026-08-10.zip`;

    await adapter.delete(artifactKey);

    expect(await adapter.exists(artifactKey)).toBe(false);
    const survivors = await adapter.list(tenantPrefix(TENANT));
    expect(survivors.map((object) => object.key).sort()).toEqual([
      `${mediaPrefix(TENANT)}a1/card.webp`,
      `${mediaPrefix(TENANT)}a1/full.webp`,
      `${mediaPrefix(TENANT)}a2/full.webp`,
    ]);
  });

  it('deleting a missing key is not an error — retries must be safe', async () => {
    await expect(adapter.delete('tenants/x/media/gone/full.webp')).resolves.toBeUndefined();
  });
});

describe('publicUrl is restricted to the media segment', () => {
  it('returns a CDN-shaped URL for a media key', () => {
    const key = `${mediaPrefix(TENANT)}a1/full.webp`;
    expect(adapter.publicUrl(key)).toContain(key);
  });

  it('REFUSES an export key — an export is a whole business in one file', () => {
    const key = `${exportsPrefix(TENANT)}sub_1-2026-08-10.zip`;
    expect(isExportKey(key)).toBe(true);
    expect(() => adapter.publicUrl(key)).toThrow(StorageError);
  });

  it('refuses anything outside a tenant media prefix', () => {
    expect(() => adapter.publicUrl('tenants/x/other/file.bin')).toThrow(StorageError);
    expect(() => adapter.publicUrl('random/file.png')).toThrow(StorageError);
  });
});

describe('signedUrl', () => {
  function verify(url: string, expectedKey: string): 'valid' | 'expired' | 'bad-signature' {
    const parsed = new URL(url);
    const key = decodeURIComponent(parsed.pathname).replace(/^\/dev-media\//, '');
    const expires = Number(parsed.searchParams.get('expires'));
    const signature = parsed.searchParams.get('signature') ?? '';

    if (!expires || expires * 1_000 < Date.now()) return 'expired';

    const expected = createHmac('sha256', getEnv().ENCRYPTION_KEY)
      .update(`${expectedKey}:${expires}`)
      .digest('base64url');

    return signature === expected && key === expectedKey ? 'valid' : 'bad-signature';
  }

  it('clamps the TTL to the platform ceiling, whatever the caller asks for', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-10T09:00:00Z'));
    const now = Math.floor(Date.now() / 1_000);

    const url = new URL(await adapter.signedUrl('tenants/x/media/a/full.webp', 30 * 24 * 3_600));
    const expires = Number(url.searchParams.get('expires'));

    // Not the 30 days the caller asked for. SigV4 could not honour that anyway (7-day ceiling),
    // and Q18's durable link is a platform route, not a signature.
    expect(expires - now).toBe(MAX_SIGNED_URL_TTL_SECONDS);
  });

  it('resolves only its OWN key', async () => {
    const key = `${exportsPrefix(TENANT)}sub_1-2026-08-10.zip`;
    const url = await adapter.signedUrl(key, 600);

    expect(verify(url, key)).toBe('valid');
    // The same signature presented for a neighbouring object must not validate.
    expect(verify(url, `${exportsPrefix(TENANT)}someone-else.zip`)).toBe('bad-signature');
  });

  it('stops resolving once the TTL has passed', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-10T09:00:00Z'));

    const key = `${exportsPrefix(TENANT)}sub_1-2026-08-10.zip`;
    const url = await adapter.signedUrl(key, 60);
    expect(verify(url, key)).toBe('valid');

    vi.setSystemTime(new Date('2026-08-10T09:02:00Z'));
    expect(verify(url, key)).toBe('expired');
  });
});

describe('the local driver is the offline development path', () => {
  it('needs no credentials, no network and no bucket', () => {
    expect(adapter.driver).toBe('local');
    expect(getEnv().STORAGE_DRIVER).toBe('local');
  });
});
