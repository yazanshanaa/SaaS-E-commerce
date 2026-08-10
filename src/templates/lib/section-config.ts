import {
  SECTION_TYPES,
  safeParseSectionConfig,
  type SectionType,
} from '@/shared/site-contract';

/**
 * Reading a stored section without letting one bad row take the site down.
 *
 * `parseSectionConfig` THROWS, and every storefront route awaits the loader that calls it — home,
 * catalogue, product, content page, and every `generateMetadata` besides. So a single Section row
 * whose config no longer satisfies its schema does not degrade one block: it returns Next's
 * generic 500, in English, on every page of that merchant's site, on every request, until someone
 * edits the database by hand. `unstable_cache` does not cache a rejection, so it never even
 * settles.
 *
 * That is reachable today, not hypothetically. The shared `sectionSchema` that A1 and B2 validate
 * writes against declares `config: z.record(z.string(), z.unknown())` — ANY object passes the
 * dashboard's save — and the per-type schemas are stricter than that by design (`limit` is capped,
 * `align` is an enum, `mediaIds` is bounded). The gap between the two is a live storefront.
 *
 * The answer is the one `src/app/site/_data/context.ts` already applies to a malformed theme row:
 * fall back rather than throw. Every one of the ten section schemas parses `{}` successfully —
 * `tests/unit/a2-storefront-logic.test.ts` pins that — so a bad config degrades to that section's
 * own defaults and the block still renders. A merchant sees their layout with a setting reset,
 * which they can fix, instead of a dead site they cannot.
 */

const SECTION_TYPE_SET: ReadonlySet<string> = new Set(SECTION_TYPES);

/**
 * Is this stored string a section type this build knows how to render?
 *
 * `SectionType` is declared twice and independently — as a Postgres enum in the schema and as
 * `SECTION_TYPES` in the shared contract — with nothing enforcing parity. The moment the database
 * enum gains a value ahead of the contract, `SECTION_CONFIG_SCHEMAS[type]` is `undefined` and the
 * parse call dereferences it. A row this build does not understand is skipped, not rendered and
 * not fatal.
 */
export function isSectionType(value: string): value is SectionType {
  return SECTION_TYPE_SET.has(value);
}

/**
 * Parse a stored config, falling back to the section's schema defaults when it no longer fits.
 *
 * Returns `Record<string, unknown>` rather than a typed config because that is what the view
 * model carries; the renderer re-parses at its own boundary to get the type back.
 */
export function normaliseSectionConfig(
  type: SectionType,
  config: unknown,
): Record<string, unknown> {
  const parsed = safeParseSectionConfig(type, config);
  if (parsed.success) return parsed.data as Record<string, unknown>;

  const defaults = safeParseSectionConfig(type, {});
  return defaults.success ? (defaults.data as Record<string, unknown>) : {};
}
