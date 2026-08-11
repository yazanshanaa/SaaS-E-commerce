import { describe, expect, it } from 'vitest';
import {
  buildImagesCsv,
  buildReadme,
  buildZip,
  pickExportVariant,
  safeFileName,
  suspensionExportKey,
  selfServeExportKey,
  UTF8_BOM,
  type ExportImageRecord,
} from '@/server/export';

/**
 * The archive itself, without a database.
 *
 * Phase 1 shipped a placeholder that concatenated the CSVs into one text blob under a `.zip`
 * key — honest about being a placeholder, and useless to a merchant who double-clicks it. These
 * are the properties that make the replacement a real delivery.
 */

const ARABIC = /[؀-ۿ]/;

function record(overrides: Partial<ExportImageRecord> = {}): ExportImageRecord {
  return {
    name: 'images/qamis.webp',
    key: 'tenants/t1/media/m1/full.webp',
    sizeBytes: 1234,
    productName: 'قميص قطن',
    productSku: 'SKU-1',
    alt: 'قميص قطن أبيض بأكمام طويلة',
    isPrimary: true,
    ...overrides,
  };
}

describe('the archive is a real ZIP', () => {
  it('starts with the local file header signature', async () => {
    const zip = await buildZip([{ name: 'README.txt', body: 'مرحبا' }]);

    // PK\x03\x04. A merchant double-clicks this file on the day their site went dark; "it is
    // named .zip" is not the same claim as "it opens".
    expect(zip.subarray(0, 4).toString('hex')).toBe('504b0304');
    expect(zip.length).toBeGreaterThan(0);
  });

  it('carries every entry it was given, at its own path', async () => {
    const zip = await buildZip([
      { name: 'products.csv', body: 'a,b\r\n' },
      { name: 'images/one.webp', body: Buffer.from([1, 2, 3]) },
    ]);

    // Entry names live in the archive as plain bytes, so this reads the central directory the
    // cheap way rather than pulling in an unzip dependency to assert two strings.
    const text = zip.toString('latin1');
    expect(text).toContain('products.csv');
    expect(text).toContain('images/one.webp');
  });

  it('is byte-identical for identical input, so a retry OVERWRITES', async () => {
    // The suspension key is deterministic precisely so a retry replaces the artifact instead of
    // orphaning a second full copy of a merchant's catalogue. That only holds if the bytes are
    // stable too — otherwise "same key" hides two different files across a retry.
    const entries = [{ name: 'products.csv', body: 'a,b\r\n' }];
    const first = await buildZip(entries);
    const second = await buildZip(entries);

    expect(first.equals(second)).toBe(true);
  });
});

describe('entry names', () => {
  it('strips characters that make an archive unextractable on Windows', () => {
    expect(safeFileName('a/b\\c:d*e?f"g<h>i|j', 'fallback')).toBe('a-b-c-d-e-f-g-h-i-j');
  });

  it('keeps Arabic, which is the merchant’s own language', () => {
    expect(safeFileName('قميص-قطن', 'fallback')).toMatch(ARABIC);
  });

  it('falls back rather than producing an empty name', () => {
    expect(safeFileName('///', 'media-1')).toBe('media-1');
    expect(safeFileName('   ', 'media-1')).toBe('media-1');
  });

  it('drops control bytes, which most extractors reject outright', () => {
    expect(safeFileName(`a${String.fromCharCode(0)}b${String.fromCharCode(31)}c`, 'x')).toBe('abc');
  });
});

describe('which variant a merchant gets back', () => {
  const full = { kind: 'full', format: 'webp', key: 'k-full-webp', sizeBytes: 900 };
  const fullAvif = { kind: 'full', format: 'avif', key: 'k-full-avif', sizeBytes: 500 };
  const card = { kind: 'card', format: 'webp', key: 'k-card', sizeBytes: 300 };

  it('prefers the largest kind', () => {
    expect(pickExportVariant([card, full])?.key).toBe('k-full-webp');
  });

  it('prefers WebP over the smaller AVIF, because the file is opened off our platform', () => {
    expect(pickExportVariant([fullAvif, full])?.key).toBe('k-full-webp');
    // With no WebP at all, AVIF is still the merchant's photograph.
    expect(pickExportVariant([fullAvif])?.key).toBe('k-full-avif');
  });

  it('returns null only when nothing was ever produced', () => {
    expect(pickExportVariant([])).toBeNull();
  });
});

describe('the index that says which photo belongs to which product', () => {
  it('is Arabic, BOM-prefixed and CRLF-terminated, so Excel opens it correctly', () => {
    const csv = buildImagesCsv([record()]);

    // Without the BOM Excel guesses the system codepage and renders Arabic as mojibake — and the
    // merchant concludes their data is corrupt, on the worst possible day.
    expect(csv.startsWith(UTF8_BOM)).toBe(true);
    expect(csv).toContain('\r\n');
    expect(csv).toMatch(ARABIC);
  });

  it('carries the alt text the merchant wrote', () => {
    expect(buildImagesCsv([record()])).toContain('قميص قطن أبيض بأكمام طويلة');
  });

  it('neutralises a product name that would execute as a spreadsheet formula', () => {
    const csv = buildImagesCsv([record({ productName: '=1+1' })]);
    expect(csv).toContain("'=1+1");
  });
});

describe('the README a merchant actually reads', () => {
  const base = {
    tenantName: 'بوتيك ليان',
    generatedAt: new Date('2026-08-11T09:00:00Z'),
    products: 15,
    categories: 5,
    images: 12,
    imagesOmitted: 0,
    // Phase 5. A shop that never enabled checkout: the orders section must not appear at all,
    // which is what the assertions below keep true.
    orders: 0,
    customerIdentifiers: false,
  };

  it('is Arabic and names the shop', () => {
    const readme = buildReadme(base);
    expect(readme).toMatch(ARABIC);
    expect(readme).toContain('بوتيك ليان');
  });

  it('states what is inside, by count', () => {
    const readme = buildReadme(base);
    expect(readme).toContain('products.csv');
    expect(readme).toContain('15');
    expect(readme).toContain('images/');
  });

  it('SAYS SO when images were left out', () => {
    // A cap nobody is told about reads as "we gave you everything" — which is the one thing this
    // file must never imply while being untrue.
    const truncated = buildReadme({ ...base, imagesOmitted: 40 });
    expect(truncated).toContain('40');
    expect(buildReadme(base)).not.toContain('40');
  });

  it('omits the images section entirely for a catalogue with no photographs', () => {
    const readme = buildReadme({ ...base, images: 0, imagesOmitted: 0 });
    expect(readme).not.toContain('images/');
  });
});

describe('where the artifact lands', () => {
  it('keeps the suspension copy out of the self-serve cleanup’s reach', () => {
    // The 24h cleanup sweeps `_exports/tmp/`. A suspension artifact inside it would be deleted
    // days into a thirty-day promise, and the link already in a merchant's WhatsApp would die.
    expect(suspensionExportKey('t1', 's1', new Date())).not.toContain('/tmp/');
    expect(selfServeExportKey('t1', new Date())).toContain('/_exports/tmp/');
  });
});
