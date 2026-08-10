import { PassThrough } from 'node:stream';
// archiver 8 is ESM with named exports only — there is no default factory to call.
import { ZipArchive } from 'archiver';

/**
 * The ZIP half of the export (B1).
 *
 * Phase 1 shipped the CSV bundle written as one concatenated text blob under a `.zip` key — a
 * placeholder that was honest about being one. This is the real archive: a merchant who opens
 * the file we sent them the day their site went dark must find their catalogue and their
 * photographs, not a text file pretending to be an archive.
 *
 * IN MEMORY, AND DELIBERATELY BOUNDED. `StorageAdapter.put()` takes a Buffer, so the archive is
 * materialised before it is stored — which is fine for a catalogue of CSVs and is exactly what
 * makes the image budget in `images.ts` load-bearing rather than decorative. Raising that budget
 * without giving the adapter a streaming `put` would trade a truncated export for a dead worker.
 */

export interface ZipEntry {
  /** Path inside the archive. Always forward slashes, never absolute. */
  name: string;
  body: Buffer | string;
}

/**
 * Store-only for entries that are already compressed.
 *
 * WebP and AVIF are compressed formats; running deflate over them costs CPU proportional to the
 * merchant's whole image library and gives back a fraction of a percent. CSVs are text and
 * compress by an order of magnitude, so they keep level 9.
 */
const STORED_EXTENSIONS = ['.webp', '.avif', '.jpg', '.jpeg', '.png', '.zip'];

function isPreCompressed(name: string): boolean {
  const lower = name.toLowerCase();
  return STORED_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

export async function buildZip(entries: ZipEntry[]): Promise<Buffer> {
  const archive = new ZipArchive({ zlib: { level: 9 } });
  const output = new PassThrough();
  const chunks: Buffer[] = [];

  const finished = new Promise<void>((resolve, reject) => {
    output.on('data', (chunk: Buffer) => chunks.push(chunk));
    output.on('end', resolve);
    output.on('error', reject);
    archive.on('error', reject);
    // A warning is not automatically fatal to archiver, but every warning we could receive here
    // means an entry did not make it in — and an export missing a file it claims to contain is
    // worse than a failed export, because nothing tells the merchant.
    archive.on('warning', reject);
  });

  archive.pipe(output);

  for (const entry of entries) {
    const body = typeof entry.body === 'string' ? Buffer.from(entry.body, 'utf8') : entry.body;
    archive.append(body, {
      name: entry.name,
      store: isPreCompressed(entry.name),
      // A fixed date keeps the artifact byte-identical across retries of the same suspension,
      // which is what makes the deterministic key an actual overwrite rather than a new object
      // with the same name and different content.
      date: new Date(0),
    });
  }

  await archive.finalize();
  await finished;

  return Buffer.concat(chunks);
}

/**
 * Punctuation an archive entry name may not carry.
 *
 * Windows refuses a name containing any of the reserved characters outright, and an archive
 * that cannot be extracted on the platform most merchants use is not a delivery.
 */
const RESERVED_NAME_CHARS = /[\\/:*?"<>| ]/g;

/**
 * Drop control bytes WITHOUT a regular expression.
 *
 * Not stylistic: a character class covering the control range is a lint error by policy, and the
 * policy is right — a control escape in a pattern is usually a mistake. Here it is not: product
 * names and alt text are merchant-supplied, and an entry name carrying a control byte is
 * rejected or silently mangled by most extractors. A code-point filter says exactly that.
 */
function withoutControlCharacters(value: string): string {
  let out = '';
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code >= 0x20 && code !== 0x7f) out += char;
  }
  return out;
}

/** A file name safe on every filesystem a merchant might unzip onto. */
export function safeFileName(value: string, fallback: string): string {
  const cleaned = withoutControlCharacters(value)
    .normalize('NFKD')
    .replace(RESERVED_NAME_CHARS, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 60);

  return cleaned.length > 0 ? cleaned : fallback;
}
