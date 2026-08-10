/**
 * The permanent legal footer — placeholders Phase 6 FILLS, not template files it edits.
 *
 * docs/PHASES.md Phase 6 builds `src/server/legal`, which generates the Arabic legal pages as
 * ordinary `Page` + `Section` rows. The contract that makes that possible without touching a
 * single file in `src/templates` is here: the slugs, the message keys for their labels, and the
 * rule for which ones appear.
 *
 * So Phase 6's whole job on the storefront side is "write the rows". If it needs a sixth page,
 * it adds a line here — not a line in a template.
 */

export interface LegalPageDescriptor {
  /** URL segment under `/p/`. English, like every other identifier. */
  slug: string;
  /** Key in `messages/ar/storefront.json` under `legal.`. */
  labelKey: string;
  /**
   * `always` — every site on every plan carries it (CLAUDE.md compliance defaults).
   * `selling` — only when `Site.sellingEnabled`, because a site that does not sell has no
   *   returns policy and no transaction to cancel.
   */
  when: 'always' | 'selling';
}

export const LEGAL_PAGES: readonly LegalPageDescriptor[] = [
  { slug: 'privacy', labelKey: 'privacy', when: 'always' },
  { slug: 'terms', labelKey: 'terms', when: 'always' },
  { slug: 'business-identity', labelKey: 'identity', when: 'always' },
  { slug: 'accessibility', labelKey: 'accessibility', when: 'always' },
  { slug: 'returns', labelKey: 'returns', when: 'selling' },
  /**
   * "إلغاء معاملة" is a PERMANENT footer link when selling is enabled — a legal requirement in
   * its own right, not a section of the returns policy. It gets its own slug so the merchant
   * can be sent straight to the cancellation route rather than to a policy they have to read.
   */
  { slug: 'cancel-transaction', labelKey: 'cancelTransaction', when: 'selling' },
] as const;

export const LEGAL_SLUGS: readonly string[] = LEGAL_PAGES.map((page) => page.slug);

export function isLegalSlug(slug: string): boolean {
  return LEGAL_SLUGS.includes(slug);
}

export function legalPagesFor(sellingEnabled: boolean): LegalPageDescriptor[] {
  return LEGAL_PAGES.filter((page) => page.when === 'always' || sellingEnabled);
}

export function legalHref(slug: string): string {
  return `/p/${slug}`;
}
