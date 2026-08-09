import { createHmac } from 'node:crypto';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { getEnv } from '@/env';
import {
  MAX_SIGNED_URL_TTL_SECONDS,
  StorageError,
  isMediaKey,
  type PutObjectOptions,
  type StorageAdapter,
  type StoredObject,
} from './types';

/**
 * DEVELOPMENT ONLY. `storage()` refuses STORAGE_DRIVER=local in production, because serving media
 * off the app server's disk breaks the CDN-over-R2 delivery rule (invariant 4).
 *
 * It exists so `pnpm dev` and the test suite work with no cloud credentials and no network —
 * and so the export contract below can be exercised before A3's R2 driver lands.
 */
export class LocalStorageAdapter implements StorageAdapter {
  readonly driver = 'local' as const;

  private root: string;

  constructor(root?: string) {
    this.root = path.resolve(root ?? getEnv().LOCAL_STORAGE_DIR);
  }

  /** Refuses any key that would escape the storage root — the dev driver still has to be safe. */
  private resolve(key: string): string {
    const normalised = path.normalize(key).replace(/^([/\\])+/, '');
    const full = path.resolve(this.root, normalised);
    if (!full.startsWith(this.root)) {
      throw new StorageError(`Refusing key outside the storage root: ${key}`);
    }
    return full;
  }

  async put(
    key: string,
    body: Buffer | Uint8Array | string,
    _options?: PutObjectOptions,
  ): Promise<StoredObject> {
    const target = this.resolve(key);
    await mkdir(path.dirname(target), { recursive: true });
    const buffer = typeof body === 'string' ? Buffer.from(body, 'utf8') : Buffer.from(body);
    await writeFile(target, buffer);
    return { key, size: buffer.byteLength, lastModified: new Date() };
  }

  async get(key: string): Promise<Buffer> {
    try {
      return await readFile(this.resolve(key));
    } catch (error) {
      throw new StorageError(`Object not found: ${key}`, error);
    }
  }

  async exists(key: string): Promise<boolean> {
    return (await this.head(key)) !== null;
  }

  async head(key: string): Promise<StoredObject | null> {
    try {
      const info = await stat(this.resolve(key));
      return { key, size: info.size, lastModified: info.mtime };
    } catch {
      return null;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.resolve(key), { force: true });
  }

  async deleteByPrefix(prefix: string): Promise<number> {
    const objects = await this.list(prefix, Number.MAX_SAFE_INTEGER);
    await rm(this.resolve(prefix), { recursive: true, force: true });
    return objects.length;
  }

  async list(prefix: string, limit = 1000): Promise<StoredObject[]> {
    const base = this.resolve(prefix);
    const results: StoredObject[] = [];

    const walk = async (dir: string): Promise<void> => {
      if (results.length >= limit) return;

      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        if (results.length >= limit) return;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
        } else {
          const info = await stat(full);
          results.push({
            key: path.relative(this.root, full).split(path.sep).join('/'),
            size: info.size,
            lastModified: info.mtime,
          });
        }
      }
    };

    await walk(base);
    return results;
  }

  /**
   * A local stand-in for a presign: an HMAC over key + expiry, verified by the dev media
   * route. Same shape, same ceiling — so code written against it behaves identically on R2.
   */
  async signedUrl(key: string, ttlSeconds: number): Promise<string> {
    const ttl = Math.min(ttlSeconds, MAX_SIGNED_URL_TTL_SECONDS);
    const expires = Math.floor(Date.now() / 1000) + ttl;
    const signature = createHmac('sha256', getEnv().ENCRYPTION_KEY)
      .update(`${key}:${expires}`)
      .digest('base64url');

    const base = getEnv().CDN_PUBLIC_BASE_URL ?? 'http://localhost:3000/dev-media';
    return `${base}/${key}?expires=${expires}&signature=${signature}`;
  }

  publicUrl(key: string): string {
    if (!isMediaKey(key)) {
      throw new StorageError(
        `Refusing a public URL for a non-media key: ${key}. The CDN origin is restricted to the media segment.`,
      );
    }
    const base = getEnv().CDN_PUBLIC_BASE_URL ?? 'http://localhost:3000/dev-media';
    return `${base}/${key}`;
  }
}
