import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildLegalPages } from '@/server/legal/content';
import { LEGAL_PROCESSOR_KEYS, type LegalFacts } from '@/server/legal/types';
import { LEGAL_PAGES, LEGAL_SLUGS } from '@/templates/lib/legal';

/**
 * The legal generator, and the promises around it that only a test can keep.
 *
 * Three kinds of assertion live here:
 *   1. the COPY is complete and correct for every branch a real tenant can be in;
 *   2. the SEAMS that must call `syncLegalPages` still do — this is the pin `src/server/legal`
 *      names in its own doc comment, and without it a later phase adding a fifth way to create a
 *      Site gets no failure, only a shop whose privacy link is a dead end;
 *   3. the DISCLOSURE stays honest across a phase boundary — the Sentry assertion below fails the
 *      day somebody wires the SDK without adding the processor line the copy then owes.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ARABIC = /[؀-ۿ]/;

function facts(overrides: Partial<LegalFacts> = {}): LegalFacts {
  return {
    tenantId: 'tenant_1',
    siteName: 'سوبر ماركت الوادي',
    isDemo: false,
    sellingEnabled: false,
    collectsOrders: false,
    analyticsEnabled: false,
    pushEnabled: false,
    activeGatewayProvider: null,
    activeGatewayIsLocal: false,
    retentionDays: 30,
    demoRequestRetentionDays: 30,
    backupIntervalHours: 6,
    backupRetentionDays: 14,
    tombstoneRetentionDays: 730,
    webhookRetentionDays: 30,
    consentCookieDays: 180,
    mediaCacheDays: 2,
    dsrUrl: 'http://app.souqbartaa.test/privacy-request',
    contactEmail: 'privacy@souqbartaa.test',
    processors: ['cloudflare', 'smtp'],
    ...overrides,
  };
}

describe('the generated legal pages', () => {
  it('covers exactly the slugs the footer links to, and no others', () => {
    const always = buildLegalPages(facts()).map((page) => page.slug);
    const selling = buildLegalPages(facts({ sellingEnabled: true })).map((page) => page.slug);

    expect(always).toEqual(
      LEGAL_PAGES.filter((page) => page.when === 'always').map((page) => page.slug),
    );
    expect(selling).toEqual(LEGAL_PAGES.map((page) => page.slug));
    expect(selling).toEqual([...LEGAL_SLUGS]);
  });

  /**
   * `AboutSection` falls back to `Site.about` for an empty body and to "من نحن" for an empty
   * title. Both fallbacks are correct for a merchant's own about block and catastrophic on a
   * privacy page: an untitled clause would render an `h2` reading "من نحن", and an empty-bodied
   * one would print the shop's marketing copy as if it were policy. Silent, plausible, wrong.
   */
  it('sets both a heading and a body on every clause, so no AboutSection fallback can fire', () => {
    for (const page of buildLegalPages(facts({ sellingEnabled: true, isDemo: true }))) {
      expect(page.title.trim()).not.toBe('');
      expect(page.metaDescription.trim()).not.toBe('');

      for (const clause of page.clauses) {
        expect(clause.heading.trim(), `${page.slug} heading`).not.toBe('');
        expect(clause.body.trim(), `${page.slug} body`).not.toBe('');
        expect(clause.heading, `${page.slug} heading is Arabic`).toMatch(ARABIC);
        expect(clause.body, `${page.slug} body is Arabic`).toMatch(ARABIC);
      }
    }
  });

  it('never leaves an unresolved {placeholder} in published copy', () => {
    for (const page of buildLegalPages(facts({ sellingEnabled: true, collectsOrders: true }))) {
      for (const clause of page.clauses) {
        expect(clause.heading, page.slug).not.toMatch(/\{\w+\}/);
        expect(clause.body, page.slug).not.toMatch(/\{\w+\}/);
      }
    }
  });

  it('closes every page with the owner-responsibility notice, on every page', () => {
    // docs/PHASES.md requires it: a generated policy that does not say final legal review is the
    // business owner's job is the platform quietly accepting a liability it cannot carry.
    for (const page of buildLegalPages(facts({ sellingEnabled: true }))) {
      const last = page.clauses.at(-1)!;
      expect(last.body, page.slug).toContain('سوق برطعة');
      expect(last.body, page.slug).toContain('سوبر ماركت الوادي');
    }
  });

  it('leads a demo with the "this is not a real shop" notice, and only a demo', () => {
    const demo = buildLegalPages(facts({ isDemo: true }));
    const real = buildLegalPages(facts());

    for (const page of demo) expect(page.clauses[0]!.heading).toContain('تجريبي');
    for (const page of real) expect(page.clauses[0]!.heading).not.toContain('تجريبي');
  });
});

describe('what the privacy policy is allowed to claim', () => {
  const privacy = (over: Partial<LegalFacts>) =>
    buildLegalPages(facts(over)).find((page) => page.slug === 'privacy')!;

  const bodies = (over: Partial<LegalFacts>) =>
    privacy(over)
      .clauses.map((clause) => `${clause.heading}\n${clause.body}`)
      .join('\n');

  /**
   * The branch that matters most. `Site.sellingEnabled` decides which PAGES exist; the storefront's
   * four-conjunct predicate decides whether a name and a phone number are collected at all. A
   * policy branching on the first would describe a collection that cannot happen — which is the
   * same class of error as omitting one that does, and harder to spot because it reads as caution.
   */
  it('describes collecting a customer name ONLY when checkout can actually run', () => {
    expect(bodies({ collectsOrders: true })).toContain('اسمك');
    expect(bodies({ sellingEnabled: true, collectsOrders: false })).toContain(
      'لا يستقبل طلبات عبر الموقع',
    );
  });

  it('describes analytics and push only when the tenant actually has them', () => {
    expect(bodies({ analyticsEnabled: false })).not.toContain('إحصاءات الزيارة');
    expect(bodies({ analyticsEnabled: true })).toContain('إحصاءات الزيارة');
    expect(bodies({ pushEnabled: false })).not.toContain('عنوان الاشتراك');
    expect(bodies({ pushEnabled: true })).toContain('عنوان الاشتراك');
  });

  it('states the backup window rather than claiming instant total erasure', () => {
    const text = bodies({});
    expect(text).toContain('النسخ الاحتياطية المشفّرة');
    expect(text).toContain('30');
    expect(text).toContain('14');
    // The sentence docs/PHASES.md forbids, in the words it forbids it in.
    expect(text).not.toContain('لا يبقى أي أثر');
  });

  it('gives the deletion record and the delivery log a stated lifetime', () => {
    const text = bodies({});
    expect(text).toContain('730');
    expect(text).toContain('سجلّ الحذف');
  });

  it('admits the cache window on a deleted image instead of saying "immediately"', () => {
    expect(bodies({ mediaCacheDays: 2 })).toContain('2 يوم');
  });

  it('names the DSR box and the contact address', () => {
    const text = bodies({});
    expect(text).toContain('http://app.souqbartaa.test/privacy-request');
    expect(text).toContain('privacy@souqbartaa.test');
  });

  it('says there is no payment processor when the active gateway is the local one', () => {
    const text = bodies({ collectsOrders: true, activeGatewayIsLocal: true });
    expect(text).toContain('لا تمرّ الدفعات عبر أي طرف خارجي');
  });

  it('has a line for every processor key, so a configured one can never render blank', () => {
    for (const key of LEGAL_PROCESSOR_KEYS) {
      const text = bodies({
        processors: [key],
        collectsOrders: key === 'gateway',
        activeGatewayProvider: key === 'gateway' ? 'meshulam' : null,
      });
      expect(text, key).toMatch(ARABIC);
    }
  });
});

/**
 * THE SEAM PIN.
 *
 * `syncLegalPages` is only as good as the list of places that call it. Every fact in `LegalFacts`
 * is written by some other module, and a writer that forgets to sync leaves a published policy
 * describing a shop that no longer exists in that shape. These paths are asserted by GREP rather
 * than by execution on purpose: the failure mode is "somebody added a new writer", and no runtime
 * test of the old writers can see that.
 */
describe('every seam that changes a legal fact still regenerates', () => {
  const SEAMS: Array<{ file: string; why: string }> = [
    { file: 'src/server/billing/index.ts', why: 'createAccount / createDemo / convertDemo' },
    { file: 'src/app/dashboard/_lib/settings.ts', why: 'the merchant selling switch' },
    { file: 'src/app/dashboard/_lib/site.ts', why: 'the shop name the policy names' },
    { file: 'src/server/admin/access.ts', why: 'analytics / push / payment_gateway overrides' },
    { file: 'src/server/admin/gateways.ts', why: 'enabling or disabling the gateway' },
    { file: 'src/server/jobs/sync-compliance.ts', why: 'the plan-edit fan-out' },
    { file: 'prisma/seed.ts', why: 'the seeded demo every test fixture is built on' },
  ];

  for (const seam of SEAMS) {
    it(`${seam.file} — ${seam.why}`, () => {
      const source = readFileSync(path.join(repoRoot, seam.file), 'utf8');
      expect(source).toContain('syncLegalPages');
    });
  }

  it('counts three sync calls in the billing service — account, demo, conversion', () => {
    const source = readFileSync(path.join(repoRoot, 'src/server/billing/index.ts'), 'utf8');
    const calls = source.match(/syncLegalPages\(/g) ?? [];
    expect(calls.length).toBe(3);
  });
});

/**
 * The disclosure that has to stay true across a phase boundary.
 *
 * `facts.ts` deliberately does NOT name Sentry as a processor, because nothing initialises the
 * SDK and naming it would claim data leaves when it does not. Phase 7 wires it. This assertion is
 * how whoever does that is told, in a failing test rather than in a comment nobody re-reads, that
 * the privacy copy now owes a line.
 */
describe('the processors list stays honest', () => {
  function walk(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry.startsWith('.')) continue;
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) out.push(...walk(full));
      else if (/\.tsx?$/.test(entry)) out.push(full);
    }
    return out;
  }

  it('does not name Sentry while the SDK is not initialised anywhere', () => {
    const initialised = walk(path.join(repoRoot, 'src')).some((file) =>
      /Sentry\.init\s*\(|withSentryConfig\s*\(/.test(readFileSync(file, 'utf8')),
    );

    const factsSource = readFileSync(
      path.join(repoRoot, 'src/server/legal/facts.ts'),
      'utf8',
    );
    const namesSentry = /keys\.push\('sentry'\)/.test(factsSource);

    expect(
      namesSentry,
      initialised
        ? 'Sentry is now initialised — the generated privacy policy owes it a PROCESSORS line'
        : 'Sentry is not initialised, so naming it as a processor would be a false disclosure',
    ).toBe(initialised);
  });
});
