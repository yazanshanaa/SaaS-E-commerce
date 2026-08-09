import { UPLOADABLE_IMAGE_MIMES, type IngestibleMime, type UploadableImageMime } from './types';

/**
 * What a file IS, decided by reading it.
 *
 * The Content-Type header and the file extension are both attacker-controlled: a browser sends
 * whatever the page told it to, and `.jpg` is eight characters anybody can type. So neither is
 * consulted here — the first bytes are (invariant 4).
 *
 * SVG is detected on purpose rather than falling into "unsupported". It is not an image the way
 * the others are: it is an XML document that may carry `<script>`, and one served from the media
 * CDN would execute on a storefront's origin. Uploaded SVG is refused with its own message. The
 * platform's OWN placeholders (B3's demo generator) are SVG and enter through
 * `ingestInternalImage`, which never touches the endpoint.
 */

export type SniffResult =
  | { ok: true; mimeType: UploadableImageMime }
  | { ok: false; reason: 'vector' | 'unsupported' | 'empty'; detected?: string };

function startsWith(buffer: Buffer, bytes: number[], offset = 0): boolean {
  if (buffer.length < offset + bytes.length) return false;
  return bytes.every((byte, index) => buffer[offset + index] === byte);
}

const JPEG = [0xff, 0xd8, 0xff];
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const GIF87 = [0x47, 0x49, 0x46, 0x38, 0x37, 0x61];
const GIF89 = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61];
const BMP = [0x42, 0x4d];
const TIFF_LE = [0x49, 0x49, 0x2a, 0x00];
const TIFF_BE = [0x4d, 0x4d, 0x00, 0x2a];
const PDF = [0x25, 0x50, 0x44, 0x46];

/** RIFF....WEBP — the container tag sits at byte 8, after the four-byte length. */
function isWebp(buffer: Buffer): boolean {
  return (
    buffer.length >= 12 &&
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WEBP'
  );
}

/**
 * An SVG has no magic number — it is text. Sniffing the first non-whitespace markup is the only
 * way, and it is enough: anything claiming to be an image that starts with an XML declaration or
 * an `<svg` tag is a vector document, and we refuse it either way.
 */
function looksLikeVector(buffer: Buffer): boolean {
  const head = buffer.subarray(0, 1_024).toString('utf8').replace(/^\uFEFF/, '').trimStart();
  return /^<\?xml[\s\S]*?<svg[\s>]/i.test(head) || /^<svg[\s>]/i.test(head);
}

export function sniffImage(buffer: Buffer): SniffResult {
  if (buffer.length === 0) {
    return { ok: false, reason: 'empty' };
  }

  if (startsWith(buffer, JPEG)) return { ok: true, mimeType: 'image/jpeg' };
  if (startsWith(buffer, PNG)) return { ok: true, mimeType: 'image/png' };
  if (isWebp(buffer)) return { ok: true, mimeType: 'image/webp' };

  if (looksLikeVector(buffer)) return { ok: false, reason: 'vector', detected: 'image/svg+xml' };

  // Named only so the log line says something useful; none of these are accepted.
  if (startsWith(buffer, GIF87) || startsWith(buffer, GIF89)) {
    return { ok: false, reason: 'unsupported', detected: 'image/gif' };
  }
  if (startsWith(buffer, BMP)) return { ok: false, reason: 'unsupported', detected: 'image/bmp' };
  if (startsWith(buffer, TIFF_LE) || startsWith(buffer, TIFF_BE)) {
    return { ok: false, reason: 'unsupported', detected: 'image/tiff' };
  }
  if (startsWith(buffer, PDF)) {
    return { ok: false, reason: 'unsupported', detected: 'application/pdf' };
  }

  return { ok: false, reason: 'unsupported' };
}

/** True when the platform itself may rasterise these bytes — includes generated vectors. */
export function sniffIngestible(buffer: Buffer): { ok: true; mimeType: IngestibleMime } | SniffResult {
  const result = sniffImage(buffer);
  if (result.ok) return result;
  if (result.reason === 'vector') return { ok: true, mimeType: 'image/svg+xml' };
  return result;
}

export function isUploadableMime(value: string): value is UploadableImageMime {
  return (UPLOADABLE_IMAGE_MIMES as readonly string[]).includes(value);
}
