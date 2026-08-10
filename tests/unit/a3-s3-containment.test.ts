import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * A3 — the S3 client stays inside `src/server/media/storage`.
 *
 * `eslint.config.mjs` already carries a `no-restricted-imports` rule for this, and
 * `tests/unit/guardrails.test.ts` scans for the `from '@aws-sdk/…'` string. Both are shared,
 * frozen files, and both miss the same forms — so this is A3's own, wider net over the rule A3
 * exists to protect.
 *
 * What they miss, verified against the installed rule implementation: `no-restricted-imports`
 * registers ImportDeclaration, ExportNamedDeclaration, ExportAllDeclaration and
 * TSImportEqualsDeclaration, and has no ImportExpression handler — so
 * `await import('@aws-sdk/client-s3')` passes lint. `require('@aws-sdk/client-s3')` passes for the
 * same reason, and neither contains the substring the guardrail scan looks for.
 *
 * Why it matters beyond tidiness: a second S3 client built elsewhere would carry its own
 * credentials, its own endpoint and — the part that bites — its own idea of a presign TTL. The
 * clamp to one hour lives in the driver, and Q18's whole design rests on nobody being able to mint
 * a longer-lived link to a merchant's catalogue. A rule enforced in one syntax and not another is
 * enforced by luck.
 */

const repoRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const ALLOWED_DIR = path.join('src', 'server', 'media', 'storage');

/** Any reference to the SDK, in any syntax: import, dynamic import, require, re-export. */
const AWS_SDK = /@aws-sdk\//;

function sourceFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      sourceFiles(full, found);
    } else if (/\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(entry)) {
      found.push(full);
    }
  }
  return found;
}

describe('the S3 client is reachable from exactly one folder', () => {
  it('is not referenced anywhere outside src/server/media/storage, in ANY syntax', () => {
    const offenders: string[] = [];

    for (const file of sourceFiles(path.join(repoRoot, 'src'))) {
      const relative = path.relative(repoRoot, file);
      if (relative.startsWith(ALLOWED_DIR)) continue;

      const source = readFileSync(file, 'utf8');
      if (AWS_SDK.test(source)) {
        offenders.push(relative);
      }
    }

    expect(offenders, 'talk to StorageAdapter instead').toEqual([]);
  });

  it('scans a meaningful number of files, so a broken walker cannot pass vacuously', () => {
    // A test that silently walks nothing is worse than no test: it reports safety it never checked.
    expect(sourceFiles(path.join(repoRoot, 'src')).length).toBeGreaterThan(50);
  });

  it('would catch a dynamic import, which the lint rule does not', () => {
    // Pinning the gap this file exists to cover: if `no-restricted-imports` ever grows an
    // ImportExpression handler this stays correct, and until then it is the only thing checking.
    const disguised = "const { S3Client } = await import('@aws-sdk/client-s3');";
    expect(AWS_SDK.test(disguised)).toBe(true);
    expect(AWS_SDK.test("const s3 = require('@aws-sdk/client-s3');")).toBe(true);
  });
});
