import { withTenantTxn, type TenantTx } from '@/server/db';
import { logger } from '@/server/logger';
import { requestStorefrontRevalidation } from '@/server/revalidation';
import { LEGAL_SLUGS } from '@/templates/lib/legal';
import { buildLegalPages } from './content';
import { loadLegalFacts } from './facts';
import type { LegalPageSpec } from './types';

/**
 * `src/server/legal` — the Arabic legal page generator (Phase 6).
 *
 * It writes ordinary `Page` + `Section` rows, which is the whole trick: the footer already links
 * to `/p/{slug}` for every entry in `src/templates/lib/legal.ts`, the content route already renders
 * a page's sections, and the sitemap already lists published pages. So filling A2's placeholders
 * meant writing rows and editing no template file — the contract A2 wrote down and this module
 * honours literally.
 *
 * Idempotent by construction. `syncLegalPages` computes the pages a site SHOULD have from live
 * facts and reconciles: it writes what differs, leaves what matches, and deletes a legal page that
 * no longer applies (turning selling off takes the returns policy and the "إلغاء معاملة" page with
 * it, because the footer stops linking to them in the same breath).
 *
 * WHY RECONCILE RATHER THAN RENDER ON READ. The pages have to be rows so that `/p/{slug}`,
 * `sitemap.xml` and the footer keep working with no special case anywhere — and so a merchant's own
 * page list shows them. The cost is that a stored page can go stale, which is why the one page that
 * must never be stale (business identity) delegates its address and phone number to live-reading
 * sections instead of freezing them (see `content.ts`).
 */

export { loadLegalFacts, dsrUrl, contactEmail, DSR_PATH } from './facts';
export { buildLegalPages } from './content';
export type { LegalFacts, LegalPageSpec, LegalClause } from './types';

/**
 * Why a sync ran. Recorded in the log line, so an operator asking "when did this shop's privacy
 * policy last change and what changed it" has an answer that is not a guess.
 */
export type LegalSyncReason =
  | 'account_created'
  | 'demo_created'
  | 'demo_converted'
  | 'selling_changed'
  | 'gateway_changed'
  | 'features_changed'
  | 'business_details_changed'
  | 'manual';

export interface SyncLegalPagesOptions {
  reason: LegalSyncReason;
  /**
   * The caller's transaction, when it already holds one.
   *
   * Account creation and the demo build both run inside `withTenantTxn`, and the legal pages must
   * commit with the tenant that owns them — a site that exists for a moment with a footer linking
   * to six pages that do not is a worse first render than no footer at all.
   */
  tx?: TenantTx;
  /**
   * Drop the storefront cache after the write. Default true, skipped when the caller is already
   * going to do it (or is inside a transaction that has not committed yet).
   */
  revalidate?: boolean;
}

export interface SyncLegalPagesResult {
  written: string[];
  unchanged: string[];
  removed: string[];
}

/**
 * The section shape a clause becomes.
 *
 * `about` because it is the only section type that renders a heading plus paragraphs, which is
 * exactly what a legal clause is — and because using it meant no new `SectionType`, no Prisma enum
 * migration, and no new entry in the dashboard's section editor for a page a merchant must not be
 * editing anyway. `AboutSection` splits the body on blank lines, so the paragraph breaks in
 * `messages/ar/legal.json` survive to the page.
 */
interface DesiredSection {
  type: string;
  sort: number;
  config: Record<string, unknown>;
}

function sectionsFor(spec: LegalPageSpec): DesiredSection[] {
  const clauses: DesiredSection[] = spec.clauses.map((clause, index) => ({
    type: 'about',
    sort: index,
    config: { title: clause.heading, body: clause.body },
  }));

  const live = (spec.liveSections ?? []).map((section, index) => ({
    type: section.type,
    sort: clauses.length + index,
    config: section.config,
  }));

  return [...clauses, ...live];
}

/** Order-insensitive comparison of what is stored against what we want. */
function sameSections(stored: DesiredSection[], desired: DesiredSection[]): boolean {
  if (stored.length !== desired.length) return false;

  const key = (section: DesiredSection) =>
    `${section.sort}|${section.type}|${JSON.stringify(section.config)}`;

  const a = stored.map(key).sort();
  const b = desired.map(key).sort();
  return a.every((value, index) => value === b[index]);
}

async function syncInTx(
  tx: TenantTx,
  tenantId: string,
  specs: LegalPageSpec[],
): Promise<SyncLegalPagesResult> {
  const result: SyncLegalPagesResult = { written: [], unchanged: [], removed: [] };
  const desiredSlugs = new Set(specs.map((spec) => spec.slug));

  /**
   * Remove legal pages that no longer apply — and ONLY ones this module owns.
   *
   * Scoped to `isSystem` and to `LEGAL_SLUGS` on purpose: a merchant page that happens to be
   * called `returns` is not ours to delete, and a system page added by a later phase under a
   * different slug is not ours either.
   */
  const stale = LEGAL_SLUGS.filter((slug) => !desiredSlugs.has(slug));
  if (stale.length > 0) {
    const removed = await tx.page.deleteMany({
      where: { tenantId, isSystem: true, slug: { in: stale } },
    });
    if (removed.count > 0) result.removed.push(...stale);
  }

  for (const spec of specs) {
    const desired = sectionsFor(spec);

    const existing = await tx.page.findFirst({
      where: { tenantId, slug: spec.slug },
      select: {
        id: true,
        title: true,
        metaDescription: true,
        isSystem: true,
        published: true,
        sort: true,
        sections: {
          select: { type: true, sort: true, config: true },
          orderBy: { sort: 'asc' },
        },
      },
    });

    const headerMatches =
      existing !== null &&
      existing.title === spec.title &&
      existing.metaDescription === spec.metaDescription &&
      existing.isSystem &&
      existing.published &&
      existing.sort === (spec.sort ?? 0);

    const storedSections: DesiredSection[] = (existing?.sections ?? []).map((section) => ({
      type: section.type,
      sort: section.sort,
      config: (section.config ?? {}) as Record<string, unknown>,
    }));

    if (headerMatches && sameSections(storedSections, desired)) {
      result.unchanged.push(spec.slug);
      continue;
    }

    const page = existing
      ? await tx.page.update({
          where: { id: existing.id },
          data: {
            title: spec.title,
            metaDescription: spec.metaDescription,
            isSystem: true,
            published: true,
            sort: spec.sort ?? 0,
          },
          select: { id: true },
        })
      : await tx.page.create({
          data: {
            tenantId,
            slug: spec.slug,
            title: spec.title,
            metaDescription: spec.metaDescription,
            isSystem: true,
            published: true,
            sort: spec.sort ?? 0,
          },
          select: { id: true },
        });

    /**
     * Sections are REPLACED, not patched.
     *
     * A clause can be added, removed or reordered between two runs (turning push on inserts one in
     * the middle of the privacy policy), so matching stored rows to desired ones would need an
     * identity these rows do not have. Replacing is correct because nothing else writes them: the
     * dashboard's section editor works on the home arrangement, and a legal page is `isSystem`.
     */
    await tx.section.deleteMany({ where: { tenantId, pageId: page.id } });
    await tx.section.createMany({
      data: desired.map((section) => ({
        tenantId,
        pageId: page.id,
        type: section.type as never,
        sort: section.sort,
        config: section.config as never,
        enabled: true,
      })),
    });

    result.written.push(spec.slug);
  }

  return result;
}

/**
 * Bring a tenant's legal pages in line with what is true about it right now.
 *
 * Safe to call more than once and safe to call when nothing changed — the common case returns
 * without a single write. Call it from any seam that changes one of the facts in `LegalFacts`;
 * `tests/unit/phase6-legal.test.ts` pins the list of those seams so a new one cannot be added
 * silently.
 */
export async function syncLegalPages(
  tenantId: string,
  options: SyncLegalPagesOptions,
): Promise<SyncLegalPagesResult> {
  const run = async (tx: TenantTx): Promise<SyncLegalPagesResult> => {
    const facts = await loadLegalFacts(tenantId, { tx });
    return syncInTx(tx, tenantId, buildLegalPages(facts));
  };

  const result = options.tx ? await run(options.tx) : await withTenantTxn(tenantId, run);

  if (result.written.length > 0 || result.removed.length > 0) {
    logger().info(
      {
        tenantId,
        reason: options.reason,
        written: result.written,
        removed: result.removed,
      },
      'legal pages synced',
    );

    /**
     * Best effort, and never inside the caller's transaction: the cache drop describes a write
     * that has not committed yet. A caller holding a transaction refreshes after it commits, or
     * lets the storefront's own TTL carry it.
     */
    if (options.revalidate !== false && !options.tx) {
      await requestStorefrontRevalidation(tenantId);
    }
  }

  return result;
}
