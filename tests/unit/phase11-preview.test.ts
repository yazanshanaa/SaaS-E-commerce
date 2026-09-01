import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Track 11.D's read-only guardrail (Phase 11, invariant extension 1).
 *
 * The live preview may not write any table, may not enqueue a job, and may not call the
 * revalidation surface — BY ITS REAL EXPORT NAMES: `requestStorefrontRevalidation` and
 * `internalRevalidateUrl` (`src/server/revalidation/index.ts:66,33`). The phase plan is explicit
 * that a grep written against an invented name passes vacuously, so the two names are themselves
 * asserted to still exist before anything is asserted absent.
 *
 * A NEW file rather than an addition to `tests/unit/guardrails.test.ts`, which is a forbidden
 * shared suite — the same reason this comment exists in the plan.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const previewDir = path.join(repoRoot, 'src', 'app', 'dashboard', 'preview');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

/** Everything that writes, enqueues or revalidates. Substrings, checked with comments stripped. */
const FORBIDDEN = [
  // The revalidation surface, by its real names.
  'requestStorefrontRevalidation',
  'internalRevalidateUrl',
  'refreshStorefront',
  'revalidatePath',
  'revalidateTag',
  // The queue surface.
  'enqueue',
  'dispatchJob',
  'Queue(',
  // The write surface of the scoped client.
  '.update(',
  '.updateMany(',
  '.upsert(',
  '.create(',
  '.createMany(',
  '.delete(',
  '.deleteMany(',
  '$executeRaw',
  '$queryRaw',
  // The audit writer — an audit row IS a write.
  'audit(',
  // No server action may live in this folder at all.
  "'use server'",
] as const;

function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

describe('the live preview is read-only, provably', () => {
  it('asserts the revalidation exports still exist under the names this file greps for', () => {
    const revalidation = readFileSync(
      path.join(repoRoot, 'src', 'server', 'revalidation', 'index.ts'),
      'utf8',
    );
    expect(revalidation).toContain('export async function requestStorefrontRevalidation');
    expect(revalidation).toContain('export function internalRevalidateUrl');
  });

  it('contains no write, no job, no revalidation and no server action anywhere in the folder', () => {
    const files = walk(previewDir);
    expect(files.length, 'the preview folder exists and has files').toBeGreaterThan(2);

    for (const file of files) {
      const source = withoutComments(readFileSync(file, 'utf8'));
      for (const forbidden of FORBIDDEN) {
        expect(
          source.includes(forbidden),
          `${path.relative(repoRoot, file)} contains "${forbidden}" — the preview must stay read-only`,
        ).toBe(false);
      }
    }
  });

  it('resolves its tenant from the session, never from a parameter', () => {
    const page = readFileSync(path.join(previewDir, 'page.tsx'), 'utf8');
    expect(page).toContain("requireMerchantPage('appearance')");
    // No tenantId is ever read out of the URL: the draft carries a template key and colours only.
    const draft = readFileSync(path.join(previewDir, '_lib', 'draft.ts'), 'utf8');
    for (const source of [withoutComments(page), withoutComments(draft)]) {
      expect(source).not.toMatch(/one\('tenant/);
      expect(source).not.toMatch(/params\[.tenantId.\]/);
    }
  });

  it('renders bare — the dashboard layout skips its chrome on the preview header', () => {
    const layout = readFileSync(
      path.join(repoRoot, 'src', 'app', 'dashboard', 'layout.tsx'),
      'utf8',
    );
    expect(layout).toContain('TENANT_HEADERS.preview');

    // And the header is stamped by the proxy from the SAME predicate as the framing exception,
    // so the two can never disagree about what "the preview" is.
    const proxy = withoutComments(
      readFileSync(path.join(repoRoot, 'src', 'proxy.ts'), 'utf8'),
    );
    expect(proxy).toContain('if (framable) headers.set(TENANT_HEADERS.preview');
  });
});
