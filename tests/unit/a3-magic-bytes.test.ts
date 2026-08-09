import { describe, expect, it } from 'vitest';
import { sniffImage, sniffIngestible, isUploadableMime } from '@/server/media/magic-bytes';

/**
 * A3 — what a file IS is decided by reading it (invariant 4).
 *
 * Every case here is written the way an attacker would send it: the right extension, the right
 * Content-Type, and the wrong bytes. Neither of the first two is consulted, which is the point.
 */

function withHeader(header: number[], tail = 64): Buffer {
  return Buffer.concat([Buffer.from(header), Buffer.alloc(tail, 0x41)]);
}

const JPEG = withHeader([0xff, 0xd8, 0xff, 0xe0]);
const PNG = withHeader([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const GIF = withHeader([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
const PDF = withHeader([0x25, 0x50, 0x44, 0x46, 0x2d]);

function webp(): Buffer {
  const buffer = Buffer.alloc(64, 0);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(56, 4);
  buffer.write('WEBP', 8, 'ascii');
  buffer.write('VP8 ', 12, 'ascii');
  return buffer;
}

describe('the upload allow-list', () => {
  it('accepts jpeg, png and webp by their magic bytes', () => {
    expect(sniffImage(JPEG)).toEqual({ ok: true, mimeType: 'image/jpeg' });
    expect(sniffImage(PNG)).toEqual({ ok: true, mimeType: 'image/png' });
    expect(sniffImage(webp())).toEqual({ ok: true, mimeType: 'image/webp' });
  });

  it('refuses a GIF even though nothing about the name would say so', () => {
    // The caller may well have been handed `photo.jpg` with `Content-Type: image/jpeg`. The
    // sniffer never sees either, and that is the whole defence.
    const result = sniffImage(GIF);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('unsupported');
  });

  it('refuses a PDF and an empty body', () => {
    expect(sniffImage(PDF).ok).toBe(false);

    const empty = sniffImage(Buffer.alloc(0));
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.reason).toBe('empty');
  });

  it('refuses a RIFF container that is not WebP', () => {
    const avi = Buffer.alloc(64, 0);
    avi.write('RIFF', 0, 'ascii');
    avi.write('AVI ', 8, 'ascii');
    expect(sniffImage(avi).ok).toBe(false);
  });

  it('refuses a truncated header rather than guessing', () => {
    expect(sniffImage(Buffer.from([0xff, 0xd8])).ok).toBe(false);
    expect(sniffImage(Buffer.from([0x89, 0x50, 0x4e])).ok).toBe(false);
  });

  it('names the uploadable mime types and nothing else', () => {
    expect(isUploadableMime('image/jpeg')).toBe(true);
    expect(isUploadableMime('image/webp')).toBe(true);
    expect(isUploadableMime('image/svg+xml')).toBe(false);
    expect(isUploadableMime('image/gif')).toBe(false);
  });
});

describe('vector documents', () => {
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>');
  const svgWithDeclaration = Buffer.from(
    '<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg"></svg>',
  );
  const svgWithScript = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg"><script>fetch("/steal")</script></svg>',
  );

  it('are refused on the upload path with their OWN reason, not a generic one', () => {
    // The merchant deserves the real answer, and the code needs to tell the two cases apart:
    // an unsupported format is a mistake, a vector is a script container.
    for (const candidate of [svg, svgWithDeclaration, svgWithScript]) {
      const result = sniffImage(candidate);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('vector');
    }
  });

  it('are refused with a leading byte-order mark and whitespace too', () => {
    const padded = Buffer.concat([
      Buffer.from('﻿   \n', 'utf8'),
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'),
    ]);
    const result = sniffImage(padded);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('vector');
  });

  it('ARE accepted on the internal path — B3 generates its own placeholders', () => {
    const result = sniffIngestible(svg);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.mimeType).toBe('image/svg+xml');
  });

  it('does not turn the internal path into a general amnesty', () => {
    expect(sniffIngestible(GIF).ok).toBe(false);
    expect(sniffIngestible(PDF).ok).toBe(false);
  });
});
