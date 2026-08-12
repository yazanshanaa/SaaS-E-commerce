import { z } from 'zod';
import { withTenantTxn } from '@/server/db';
import { can, canEdit } from '@/server/entitlements';
import {
  CUSTOM_HTML_FEATURE_KEY,
  isCustomHtmlAllowed,
} from '@/templates/lib/custom-html-gate';
import {
  HOME_PAGE_SLUG,
  SECTION_CONFIG_SCHEMAS,
  parseSectionConfig,
  safeParseSectionConfig,
  type SectionConfig,
  type SectionType,
} from '@/shared/site-contract';
import type { MerchantContext } from './context';
import { refreshStorefront } from './audit';
import { failure, invalid, type ActionState } from './validation';

/**
 * The home page's sections — what shows, in what order, configured how.
 *
 * The whole screen sits behind ONE capability, `sections_layout`, which is admin on أساسي and
 * متجر and merchant only on احترافي (Q4: rare change, very high blast radius). So the guard is
 * per-screen rather than per-field, and a locked merchant gets the read-only view plus the
 * request button like anywhere else.
 *
 * Every config is validated against the per-type zod schema in `src/shared/site-contract` and
 * never against `src/templates`: A2 owns the templates, and a dashboard that read section shapes
 * out of a template folder would break the moment a template stopped rendering a field.
 *
 * `custom_html` is additionally gated, and it reuses A2's `isCustomHtmlAllowed` rather than
 * asking the feature directly. There is no `custom_html` key in the frozen feature list, so A2
 * pinned the substitute (`seo_tools`) and the demo exclusion in ONE constant — importing it is
 * what keeps the editor and the renderer from disagreeing about whether a shop may execute
 * markup somebody typed. A second copy of that rule here is exactly the drift that ends with a
 * dashboard happily saving a block the storefront refuses to render, or worse, the reverse.
 */

export interface SectionRow {
  id: string;
  type: SectionType;
  enabled: boolean;
  sort: number;
  pageId: string;
  config: Record<string, unknown>;
}

export interface SectionsView {
  sections: SectionRow[];
  editable: boolean;
  customHtmlAllowed: boolean;
}

export async function loadSections(ctx: MerchantContext): Promise<SectionsView> {
  const [rows, editable, customHtmlFeature, tenant] = await Promise.all([
    /**
     * The HOME arrangement only. Phase 6's generated legal pages are `Section` rows too, and a
     * merchant reordering their shop must not be shown — or able to disable — a clause of their
     * own privacy policy.
     */
    ctx.db.section.findMany({
      where: { tenantId: ctx.tenantId, page: { slug: HOME_PAGE_SLUG } },
      orderBy: [{ sort: 'asc' }, { createdAt: 'asc' }],
      select: { id: true, type: true, enabled: true, sort: true, pageId: true, config: true },
    }),
    canEdit(ctx.tenantId, ctx.role, 'sections_layout'),
    can(ctx.tenantId, CUSTOM_HTML_FEATURE_KEY),
    ctx.db.tenant.findUnique({ where: { id: ctx.tenantId }, select: { isDemo: true } }),
  ]);

  return {
    sections: rows.map((row) => ({
      id: row.id,
      type: row.type as SectionType,
      enabled: row.enabled,
      sort: row.sort,
      pageId: row.pageId,
      // A stored config that no longer matches its schema still renders its known fields: the
      // contract strips unknown keys rather than rejecting, so an older shape must not become
      // an unusable form.
      config: normaliseConfig(row.type as SectionType, row.config),
    })),
    editable,
    customHtmlAllowed: isCustomHtmlAllowed({
      featureEnabled: customHtmlFeature === true,
      isDemo: tenant?.isDemo ?? false,
    }),
  };
}

function normaliseConfig(type: SectionType, config: unknown): Record<string, unknown> {
  const parsed = safeParseSectionConfig(type, config);
  return (parsed.success ? parsed.data : parseSectionConfig(type, {})) as Record<string, unknown>;
}

async function assertEditable(ctx: MerchantContext): Promise<ActionState | null> {
  if (await canEdit(ctx.tenantId, ctx.role, 'sections_layout')) return null;
  return failure('dashboard:errors.capabilityLocked');
}

// -----------------------------------------------------------------------------
// Layout
// -----------------------------------------------------------------------------

export const layoutSchema = z.object({
  sections: z
    .array(z.object({ id: z.string().trim().min(1), enabled: z.boolean() }))
    .min(1)
    .max(40),
});

/**
 * Save visibility and order together, in the order the array arrives.
 *
 * One submit rather than a toggle per row: reordering and hiding are the same gesture on this
 * screen, and two endpoints would let a merchant leave the two halves disagreeing — a section
 * hidden in one save and moved in another, with a failed request in between.
 */
export async function saveLayout(ctx: MerchantContext, raw: unknown): Promise<ActionState | null> {
  const locked = await assertEditable(ctx);
  if (locked) return locked;

  const parsed = layoutSchema.safeParse(raw);
  if (!parsed.success) return invalid(parsed.error);

  await withTenantTxn(
    ctx.tenantId,
    async (tx) => {
      for (const [index, section] of parsed.data.sections.entries()) {
        /**
         * Matched on tenantId AND on the home page.
         *
         * The tenant match was always there — RLS refuses a foreign row anyway, and `updateMany`
         * turns that into a no-op rather than an error, so a stale tab cannot reorder another
         * shop's page. The PAGE match is Phase 6's: legal pages are `Section` rows now, and
         * without it a merchant could post a clause id from their own privacy policy and disable
         * it. `Page.isSystem` documents that these must not be deletable by the merchant; this is
         * what makes the sentence true rather than decorative.
         */
        await tx.section.updateMany({
          where: {
            id: section.id,
            tenantId: ctx.tenantId,
            page: { slug: HOME_PAGE_SLUG },
          },
          data: { enabled: section.enabled, sort: index },
        });
      }
    },
    { actor: ctx.actor },
  );

  await refreshStorefront(ctx.tenantId);
  return null;
}

/** The layout in the shape A1 applies verbatim on approval (`sectionsLayoutPayload`). */
export function layoutPayloadFrom(sections: Array<{ id: string; enabled: boolean }>): unknown {
  return {
    sections: sections.map((section, index) => ({
      id: section.id,
      enabled: section.enabled,
      sort: index,
    })),
  };
}

// -----------------------------------------------------------------------------
// Per-section configuration
// -----------------------------------------------------------------------------

export const sectionConfigSchema = z.object({
  sectionId: z.string().trim().min(1),
  config: z.record(z.string(), z.unknown()),
});

export async function saveSectionConfig(
  ctx: MerchantContext,
  raw: unknown,
): Promise<ActionState | null> {
  const locked = await assertEditable(ctx);
  if (locked) return locked;

  const parsed = sectionConfigSchema.safeParse(raw);
  if (!parsed.success) return invalid(parsed.error);

  // Page-scoped like the write below: a clause id from a generated legal page must not resolve
  // here at all, so the refusal happens before any type-specific branch runs.
  const section = await ctx.db.section.findFirst({
    where: { id: parsed.data.sectionId, tenantId: ctx.tenantId, page: { slug: HOME_PAGE_SLUG } },
    select: { id: true, type: true },
  });
  if (!section) return failure('dashboard:errors.notFound');

  const type = section.type as SectionType;

  if (type === 'custom_html') {
    const [featureEnabled, tenant] = await Promise.all([
      can(ctx.tenantId, CUSTOM_HTML_FEATURE_KEY),
      ctx.db.tenant.findUnique({ where: { id: ctx.tenantId }, select: { isDemo: true } }),
    ]);

    if (!isCustomHtmlAllowed({ featureEnabled: featureEnabled === true, isDemo: tenant?.isDemo ?? false })) {
      return failure('dashboard:errors.capabilityLocked');
    }
  }

  const config = SECTION_CONFIG_SCHEMAS[type].safeParse(parsed.data.config);
  if (!config.success) return invalid(config.error);

  /**
   * The NORMALISED config is stored, not whatever arrived: defaults are filled in and unknown keys
   * are stripped, so a section written here is byte-identical to one A1 or B3 would write.
   *
   * `updateMany` scoped to the home page rather than `update` by id — Phase 6. The lookup that
   * found this section is page-scoped, but the write was not, and a posted id from a generated
   * legal page would have let a merchant rewrite a clause of their own privacy policy.
   */
  await ctx.db.section.updateMany({
    where: { id: section.id, tenantId: ctx.tenantId, page: { slug: HOME_PAGE_SLUG } },
    data: { config: config.data as object },
  });

  await refreshStorefront(ctx.tenantId);
  return null;
}

export { SECTION_CONFIG_SCHEMAS, parseSectionConfig };
export type { SectionConfig, SectionType };
