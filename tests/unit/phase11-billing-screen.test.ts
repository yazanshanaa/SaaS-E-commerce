import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Track 11.H's gate half that a unit test can carry (Phase 11, Q35).
 *
 * The merchant subscription screen displays money, and invariant 5 is not negotiable for money:
 * no billing or subscription state mutation may live outside `src/server/billing`. The existing
 * guardrail enforces that platform-wide; this file points the same expectation at the NEW
 * folder specifically, plus the read path it depends on — so a later edit that adds a "quick"
 * subscription write to the screen, or a payment write to the view, fails a named test rather
 * than a general one someone might silence.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const billingDir = path.join(repoRoot, 'src', 'app', 'dashboard', 'billing');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

/** Anything that mutates, plus the transition surface of the billing service itself. */
const FORBIDDEN = [
  "'use server'",
  '.update(',
  '.updateMany(',
  '.upsert(',
  '.create(',
  '.createMany(',
  '.delete(',
  '.deleteMany(',
  '$executeRaw',
  'recordPayment',
  'extendRetention',
  'reactivate',
  'suspend(',
  'purgeTenant',
  'reissueExportLink',
] as const;

describe('the merchant subscription screen is read-only (invariant 5)', () => {
  it('contains no mutation and no server action anywhere in the folder', () => {
    const files = walk(billingDir);
    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      const source = withoutComments(readFileSync(file, 'utf8'));
      for (const forbidden of FORBIDDEN) {
        expect(
          source.includes(forbidden),
          `${path.relative(repoRoot, file)} contains "${forbidden}"`,
        ).toBe(false);
      }
    }
  });

  it('reads every number through src/server/billing, and is guarded at the billing scope', () => {
    const page = readFileSync(path.join(billingDir, 'page.tsx'), 'utf8');
    expect(page).toContain("merchantSubscriptionView");
    expect(page).toContain("from '@/server/billing'");
    // Owner-only AT THE ROUTE (Q13) — the same 404 every other ungranted screen returns.
    expect(page).toContain("requireMerchantPage('billing')");
  });

  it('keeps the view itself read-only: scoped client, finds and counts, no writes', () => {
    const view = withoutComments(
      readFileSync(path.join(repoRoot, 'src', 'server', 'billing', 'merchant-view.ts'), 'utf8'),
    );
    for (const forbidden of ['.update(', '.upsert(', '.create(', '.delete(', 'emitEvent', 'dispatchJob']) {
      expect(view.includes(forbidden), `merchant-view.ts contains "${forbidden}"`).toBe(false);
    }
    // The Q18 link is shown only when the artifact exists — never a promised copy that does not.
    expect(view).toContain('exportGeneratedAt');
  });

  it('is role-gated for staff by the scope table, not by the nav', () => {
    const rbac = readFileSync(path.join(repoRoot, 'src', 'server', 'auth', 'rbac.ts'), 'utf8');
    // `billing` is a scope and is NOT in STAFF_ALLOWED — the predicate the route's guard runs.
    expect(rbac).toContain("'billing'");
    const staffBlock = rbac.slice(rbac.indexOf('STAFF_ALLOWED'), rbac.indexOf('roleHasScope'));
    expect(staffBlock).not.toContain("'billing'");
  });
});
