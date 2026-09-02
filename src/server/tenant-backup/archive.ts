import { inflateRawSync } from 'node:zlib';
import { BackupError } from './types';

/**
 * Reading back a ZIP this platform wrote.
 *
 * WHY THIS IS HAND-WRITTEN. `archiver` — already a dependency, already used by
 * `src/server/export/zip.ts` — only WRITES. Every popular reader is a new dependency in the
 * production image, and the thing being parsed here is not arbitrary user input from the internet:
 * it is an archive this codebase produced, stored encrypted under the tenant's own prefix, and
 * handed back to a super admin. A hundred lines of format code with no supply chain is the better
 * trade at that size, and CLAUDE.md's "do not substitute the stack without asking" points the same
 * way for an addition nobody asked for.
 *
 * IT READS THE CENTRAL DIRECTORY, not the stream of local headers, and that is the one decision
 * worth knowing. A local file header may carry zeroed sizes with the real values in a trailing
 * data descriptor — which is exactly what a streaming writer like `archiver` emits — so a naive
 * forward scan reads a length of zero and produces an empty file with no error at all. The central
 * directory at the end of the archive always carries the true compressed and uncompressed sizes.
 *
 * NOT A GENERAL-PURPOSE UNZIP. No encryption, no multi-disk, no ZIP64 — the last of those is
 * DETECTED and refused loudly rather than misread, because the failure mode of guessing is a
 * restore that silently loads half a shop.
 */

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const ZIP64_EOCD_LOCATOR_SIGNATURE = 0x07064b50;

const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

/** The EOCD is at most 22 bytes plus a comment of at most 65535. */
const MAX_EOCD_SCAN = 22 + 0xffff;

interface ZipEntryRecord {
  name: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

export interface ArchiveReader {
  names(): string[];
  has(name: string): boolean;
  /** UTF-8 text, or null when the entry is absent. */
  text(name: string): string | null;
  /** Raw bytes, or null when the entry is absent. */
  binary(name: string): Buffer | null;
}

function findEocd(buffer: Buffer): number {
  const start = Math.max(0, buffer.length - MAX_EOCD_SCAN);
  for (let offset = buffer.length - 22; offset >= start; offset -= 1) {
    if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) return offset;
  }
  throw new BackupError('corruptArchive', 'No end-of-central-directory record: this is not a ZIP.');
}

function assertNoZip64(buffer: Buffer, eocd: number): void {
  const locator = eocd - 20;
  if (locator >= 0 && buffer.readUInt32LE(locator) === ZIP64_EOCD_LOCATOR_SIGNATURE) {
    throw new BackupError(
      'corruptArchive',
      'This archive uses ZIP64, which this reader does not parse. It was almost certainly written by something other than this platform.',
    );
  }
}

function parseCentralDirectory(buffer: Buffer): Map<string, ZipEntryRecord> {
  const eocd = findEocd(buffer);
  assertNoZip64(buffer, eocd);

  const entryCount = buffer.readUInt16LE(eocd + 10);
  let cursor = buffer.readUInt32LE(eocd + 16);

  const entries = new Map<string, ZipEntryRecord>();

  for (let index = 0; index < entryCount; index += 1) {
    if (buffer.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) {
      throw new BackupError('corruptArchive', 'The central directory is malformed.');
    }

    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localHeaderOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength);

    // Directory entries end in '/' and carry no data. Skipped rather than stored, so `names()`
    // lists files and only files.
    if (!name.endsWith('/')) {
      entries.set(name, { name, method, compressedSize, uncompressedSize, localHeaderOffset });
    }

    cursor += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

function readEntry(buffer: Buffer, entry: ZipEntryRecord): Buffer {
  const header = entry.localHeaderOffset;
  if (buffer.readUInt32LE(header) !== LOCAL_SIGNATURE) {
    throw new BackupError('corruptArchive', `The local header for ${entry.name} is malformed.`);
  }

  // The local header's own name and extra lengths, NOT the central directory's — a writer may put
  // different extra fields in each, and reading the wrong one lands the data offset in the middle
  // of a field.
  const nameLength = buffer.readUInt16LE(header + 26);
  const extraLength = buffer.readUInt16LE(header + 28);
  const dataStart = header + 30 + nameLength + extraLength;
  const data = buffer.subarray(dataStart, dataStart + entry.compressedSize);

  if (entry.method === METHOD_STORE) return Buffer.from(data);
  if (entry.method === METHOD_DEFLATE) return inflateRawSync(data);

  throw new BackupError(
    'corruptArchive',
    `${entry.name} uses compression method ${entry.method}, which this platform never writes.`,
  );
}

/**
 * Parse once, read many.
 *
 * Entries are inflated LAZILY and memoised: a restore reads every data file but only the media it
 * has rows for, and inflating a 400MB image set nobody asks for would double peak memory on the
 * one path already documented as memory-bound (`build.ts`).
 */
export async function readArchive(body: Buffer): Promise<ArchiveReader> {
  const entries = parseCentralDirectory(body);
  const cache = new Map<string, Buffer>();

  const read = (name: string): Buffer | null => {
    const cached = cache.get(name);
    if (cached) return cached;

    const entry = entries.get(name);
    if (!entry) return null;

    const decoded = readEntry(body, entry);
    cache.set(name, decoded);
    return decoded;
  };

  return {
    names: () => [...entries.keys()],
    has: (name) => entries.has(name),
    binary: read,
    text: (name) => {
      const decoded = read(name);
      return decoded ? decoded.toString('utf8') : null;
    },
  };
}
