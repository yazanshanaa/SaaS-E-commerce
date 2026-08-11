import { z } from 'zod';
import { withTenantTxn, type TenantTx } from '@/server/db';
import { can } from '@/server/entitlements';
import { assertProductImageAlt, isMediaError, type MediaView } from '@/server/media';
import { shortId } from '@/server/crypto';
import type { MerchantContext } from './context';
import { auditInTx, refreshStorefront } from './audit';
import {
  failure,
  integerField,
  invalid,
  optionalSlugField,
  optionalText,
  priceField,
  requiredText,
  slugCandidate,
  type ActionState,
} from './validation';

/**
 * The catalogue — the screen a merchant lives in.
 *
 * Products are deliberately NOT one of the six managed capabilities (docs/PHASES.md): price and
 * availability edits are the most frequent action in any shop, and routing them through change
 * requests would burn a basic plan's two monthly requests in the first week. So there is no
 * `canEdit` here. What there IS, on every write path, is the plan's `products_limit` — resolved
 * through `can()` and never by branching on a plan name (invariant 2).
 *
 * CATEGORIES LIVE HERE TOO, and that is a scope call worth stating: docs/PHASES.md lists
 * "category" as a product FIELD and never says who creates one. Nobody else can — A1's
 * site-content tab does not manage them and B3 only seeds demo packs — so without this a
 * merchant could pick a category and never make one, and A2's categories section would render
 * empty forever on every real account. A category is part of the catalogue, not appearance, so
 * it follows products rather than the capability axis.
 */

export interface ProductImageView {
  id: string;
  mediaId: string;
  alt: string;
  sort: number;
  isPrimary: boolean;
  previewUrl: string | null;
  ready: boolean;
}

export interface ProductRow {
  id: string;
  name: string;
  slug: string;
  priceAgorot: number;
  available: boolean;
  published: boolean;
  sort: number;
  categoryId: string | null;
  categoryName: string | null;
  primaryImageUrl: string | null;
  imageCount: number;
}

export interface ProductDetail {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  sku: string | null;
  priceAgorot: number;
  available: boolean;
  published: boolean;
  badge: string | null;
  categoryId: string | null;
  seoTitle: string | null;
  seoDescription: string | null;
  images: ProductImageView[];
}

export interface CategoryRow {
  id: string;
  key: string;
  name: string;
  sort: number;
  published: boolean;
  productCount: number;
}

export interface CatalogueLimits {
  /** null when the feature is absent — treated as zero, never as unlimited. */
  limit: number;
  used: number;
  remaining: number;
  reached: boolean;
}

const VARIANT_PREVIEW = (variants: Array<{ kind: string; format: string; url: string }>) =>
  variants.find((v) => v.kind === 'card' && v.format === 'webp')?.url ??
  variants.find((v) => v.kind === 'thumb' && v.format === 'webp')?.url ??
  null;

// -----------------------------------------------------------------------------
// Reading
// -----------------------------------------------------------------------------

export async function catalogueLimits(ctx: MerchantContext): Promise<CatalogueLimits> {
  /**
   * An ABSENT `products_limit` is zero, not unlimited.
   *
   * A missing feature means we could not establish what this tenant is entitled to, and
   * admitting a write on that basis is how a plan gets quietly bypassed. The same fail-closed
   * rule A3 applies to storage.
   */
  const configured = await can(ctx.tenantId, 'products_limit');
  const limit = typeof configured === 'number' && configured >= 0 ? configured : 0;

  const used = await ctx.db.product.count({ where: { tenantId: ctx.tenantId } });

  return { limit, used, remaining: Math.max(0, limit - used), reached: used >= limit };
}

export async function listProducts(ctx: MerchantContext): Promise<ProductRow[]> {
  const rows = await ctx.db.product.findMany({
    where: { tenantId: ctx.tenantId },
    orderBy: [{ sort: 'asc' }, { createdAt: 'asc' }],
    select: {
      id: true,
      name: true,
      slug: true,
      priceAgorot: true,
      available: true,
      published: true,
      sort: true,
      categoryId: true,
      category: { select: { name: true } },
      images: {
        orderBy: [{ isPrimary: 'desc' }, { sort: 'asc' }],
        select: {
          isPrimary: true,
          media: { select: { status: true, variants: { select: { kind: true, format: true, key: true } } } },
        },
      },
    },
  });

  // URLs are minted by the media module, which is the only place allowed to know the CDN base.
  const { mediaStorage } = await import('@/server/media');
  const store = mediaStorage();

  return rows.map((row) => {
    const first = row.images[0];
    const variants =
      first?.media.variants.map((v) => ({ ...v, url: store.publicUrl(v.key) })) ?? [];

    return {
      id: row.id,
      name: row.name,
      slug: row.slug,
      priceAgorot: row.priceAgorot,
      available: row.available,
      published: row.published,
      sort: row.sort,
      categoryId: row.categoryId,
      categoryName: row.category?.name ?? null,
      primaryImageUrl: VARIANT_PREVIEW(variants),
      imageCount: row.images.length,
    };
  });
}

export async function getProduct(
  ctx: MerchantContext,
  productId: string,
): Promise<ProductDetail | null> {
  const row = await ctx.db.product.findFirst({
    where: { id: productId, tenantId: ctx.tenantId },
    select: {
      id: true,
      name: true,
      slug: true,
      description: true,
      sku: true,
      priceAgorot: true,
      available: true,
      published: true,
      badge: true,
      categoryId: true,
      seoTitle: true,
      seoDescription: true,
      images: {
        orderBy: [{ isPrimary: 'desc' }, { sort: 'asc' }],
        select: {
          id: true,
          mediaId: true,
          alt: true,
          sort: true,
          isPrimary: true,
          media: { select: { status: true, variants: { select: { kind: true, format: true, key: true } } } },
        },
      },
    },
  });

  if (!row) return null;

  const { mediaStorage } = await import('@/server/media');
  const store = mediaStorage();

  return {
    ...row,
    images: row.images.map((image) => ({
      id: image.id,
      mediaId: image.mediaId,
      alt: image.alt,
      sort: image.sort,
      isPrimary: image.isPrimary,
      ready: image.media.status === 'ready',
      previewUrl: VARIANT_PREVIEW(
        image.media.variants.map((v) => ({ ...v, url: store.publicUrl(v.key) })),
      ),
    })),
  };
}

export async function listCategories(ctx: MerchantContext): Promise<CategoryRow[]> {
  const rows = await ctx.db.category.findMany({
    where: { tenantId: ctx.tenantId },
    orderBy: [{ sort: 'asc' }, { name: 'asc' }],
    select: {
      id: true,
      key: true,
      name: true,
      sort: true,
      published: true,
      _count: { select: { products: true } },
    },
  });

  return rows.map((row) => ({
    id: row.id,
    key: row.key,
    name: row.name,
    sort: row.sort,
    published: row.published,
    productCount: row._count.products,
  }));
}

// -----------------------------------------------------------------------------
// Writing
// -----------------------------------------------------------------------------

export const productSchema = z.object({
  id: z.string().trim().optional(),
  name: requiredText(140, 2),
  slug: optionalSlugField,
  description: optionalText(4_000),
  sku: optionalText(60),
  priceAgorot: priceField,
  categoryId: z
    .string()
    .trim()
    .transform((value) => (value === '' ? null : value))
    .nullable()
    .default(null),
  available: z.boolean(),
  published: z.boolean(),
  badge: optionalText(30),
  seoTitle: optionalText(120),
  seoDescription: optionalText(300),
});

export type ProductInput = z.infer<typeof productSchema>;

/**
 * `FOR UPDATE` on the tenant row before the count.
 *
 * The count-then-insert sequence is a classic over-admission race: under READ COMMITTED two
 * saves landing together both read `used = 29` on a 30-product plan and both insert. The lock
 * serialises the read-decide-insert on the tenant row so the second transaction reads a number
 * that already includes the first. It is held for the few statements below and never across
 * anything slow.
 */
async function admitOneProduct(
  tx: TenantTx,
  ctx: MerchantContext,
  limit: number,
): Promise<boolean> {
  await tx.$executeRaw`SELECT 1 FROM "tenants" WHERE "id" = ${ctx.tenantId} FOR UPDATE`;
  const used = await tx.product.count({ where: { tenantId: ctx.tenantId } });
  return used < limit;
}

export interface SaveProductResult {
  state: ActionState | null;
  productId?: string;
  /** Set when the plan limit refused the create, so the screen can name the number. */
  limit?: number;
}

export async function saveProduct(
  ctx: MerchantContext,
  raw: unknown,
): Promise<SaveProductResult> {
  const parsed = productSchema.safeParse(raw);
  if (!parsed.success) return { state: invalid(parsed.error) };

  const input = parsed.data;
  const slug = input.slug ?? slugCandidate(input.name, 'product', shortId(6));

  const category = input.categoryId
    ? await ctx.db.category.findFirst({
        where: { id: input.categoryId, tenantId: ctx.tenantId },
        select: { id: true },
      })
    : null;

  // A category id that does not belong to this tenant is dropped rather than refused: RLS
  // already makes it unreachable, and a form that rejects an id the merchant cannot even see
  // is a dead end they cannot fix.
  const categoryId = category?.id ?? null;

  const data = {
    name: input.name,
    slug,
    description: input.description ?? null,
    sku: input.sku ?? null,
    priceAgorot: input.priceAgorot,
    categoryId,
    available: input.available,
    published: input.published,
    badge: input.badge ?? null,
    seoTitle: input.seoTitle ?? null,
    seoDescription: input.seoDescription ?? null,
  };

  const { limit } = await catalogueLimits(ctx);

  try {
    const result = await withTenantTxn(
      ctx.tenantId,
      async (tx): Promise<SaveProductResult> => {
        if (input.id) {
          const before = await tx.product.findFirst({
            where: { id: input.id, tenantId: ctx.tenantId },
            select: { name: true, slug: true, priceAgorot: true, published: true, available: true },
          });
          if (!before) return { state: failure('dashboard:errors.notFound') };

          await tx.product.update({ where: { id: input.id }, data });
          return { state: null, productId: input.id };
        }

        if (!(await admitOneProduct(tx, ctx, limit))) {
          return { state: failure('dashboard:products.limitReached'), limit };
        }

        const last = await tx.product.findFirst({
          where: { tenantId: ctx.tenantId },
          orderBy: { sort: 'desc' },
          select: { sort: true },
        });

        const created = await tx.product.create({
          data: { ...data, tenantId: ctx.tenantId, sort: (last?.sort ?? -1) + 1 },
          select: { id: true },
        });

        await auditInTx(tx, ctx, {
          action: 'product.created',
          entityType: 'product',
          entityId: created.id,
          after: { name: data.name, slug: data.slug, priceAgorot: data.priceAgorot },
        });

        return { state: null, productId: created.id };
      },
      { actor: ctx.actor },
    );

    if (!result.state) await refreshStorefront(ctx.tenantId);
    return result;
  } catch (error) {
    if (isUniqueSlugViolation(error)) {
      return {
        state: failure('dashboard:errors.validation', [
          { field: 'slug', messageKey: 'dashboard:errors.slugTaken' },
        ]),
      };
    }
    throw error;
  }
}

/**
 * A slug collision is the ONE database error this form turns into a field message.
 *
 * Everything else propagates: an unexpected constraint rendered as "choose another link" would
 * send the merchant round a loop changing a field that was never the problem. The check reads
 * the Prisma error shape without importing the client (invariant 1 forbids that outside
 * `src/server/db`), which is why it is a structural test rather than an `instanceof`.
 */
function isUniqueSlugViolation(error: unknown): boolean {
  const candidate = error as { code?: string; meta?: { target?: unknown } } | null;
  if (!candidate || candidate.code !== 'P2002') return false;

  const target = candidate.meta?.target;
  const fields = Array.isArray(target) ? target.map(String) : [String(target ?? '')];
  return fields.some((field) => field.includes('slug'));
}

export async function deleteProduct(
  ctx: MerchantContext,
  productId: string,
): Promise<ActionState | null> {
  const state = await withTenantTxn(
    ctx.tenantId,
    async (tx): Promise<ActionState | null> => {
      const before = await tx.product.findFirst({
        where: { id: productId, tenantId: ctx.tenantId },
        select: { name: true, slug: true, priceAgorot: true },
      });
      if (!before) return failure('dashboard:errors.notFound');

      await auditInTx(tx, ctx, {
        action: 'product.deleted',
        entityType: 'product',
        entityId: productId,
        before,
      });

      // ProductImage cascades; the Media rows and their objects stay, because a photo may be
      // used by another product and deleting bytes here would blank a live page elsewhere.
      await tx.product.delete({ where: { id: productId } });
      return null;
    },
    { actor: ctx.actor },
  );

  if (!state) await refreshStorefront(ctx.tenantId);
  return state;
}

export const reorderSchema = z.object({
  productIds: z.array(z.string().trim().min(1)).min(1).max(1_000),
});

/**
 * Persist a whole ordering in one transaction.
 *
 * A full renumber rather than the swap A1 uses for sections, because this is a drag: the
 * merchant moved one card across twenty positions and every row between them genuinely changed.
 * Rows are matched on `id` AND `tenantId` — RLS refuses a foreign id anyway, and `updateMany`
 * makes that a no-op instead of an error, so a stale tab cannot reorder someone else's shop.
 */
export async function reorderProducts(
  ctx: MerchantContext,
  raw: unknown,
): Promise<ActionState | null> {
  const parsed = reorderSchema.safeParse(raw);
  if (!parsed.success) return invalid(parsed.error);

  await withTenantTxn(
    ctx.tenantId,
    async (tx) => {
      for (const [index, productId] of parsed.data.productIds.entries()) {
        await tx.product.updateMany({
          where: { id: productId, tenantId: ctx.tenantId },
          data: { sort: index },
        });
      }
    },
    { actor: ctx.actor },
  );

  await refreshStorefront(ctx.tenantId);
  return null;
}

// -----------------------------------------------------------------------------
// Product images
// -----------------------------------------------------------------------------

export const attachImageSchema = z.object({
  productId: z.string().trim().min(1),
  mediaId: z.string().trim().min(1),
  alt: z.string(),
});

/**
 * Link a library photo to a product, with Arabic alt text (invariant 4).
 *
 * The alt text is validated by A3's `assertProductImageAlt`, which owns every length and script
 * rule and answers with an Arabic sentence — so this never re-implements the bounds and never
 * lets a raw zod message in English reach a merchant.
 */
export async function attachProductImage(
  ctx: MerchantContext,
  raw: unknown,
): Promise<ActionState | null> {
  const parsed = attachImageSchema.safeParse(raw);
  if (!parsed.success) return invalid(parsed.error);

  let alt: string;
  try {
    alt = assertProductImageAlt(parsed.data.alt);
  } catch (error) {
    if (isMediaError(error)) {
      return failure('dashboard:errors.validation', [
        // A3 already resolved this through the i18n layer WITH its own limit numbers, which are
        // private to that module. Passing the sentence keeps `{max}` from reaching a merchant.
        { field: 'alt', messageKey: `media:errors.${error.code}`, message: error.arabicMessage },
      ]);
    }
    throw error;
  }

  const state = await withTenantTxn(
    ctx.tenantId,
    async (tx): Promise<ActionState | null> => {
      const product = await tx.product.findFirst({
        where: { id: parsed.data.productId, tenantId: ctx.tenantId },
        select: { id: true },
      });
      if (!product) return failure('dashboard:errors.notFound');

      const media = await tx.media.findFirst({
        where: { id: parsed.data.mediaId, tenantId: ctx.tenantId },
        select: { id: true, status: true },
      });
      if (!media) return failure('dashboard:errors.notFound');

      // A photo still in the pipeline has no variants, and A2 renders variants only — attaching
      // it would put an empty frame on a live product page until the worker caught up.
      if (media.status !== 'ready') return failure('dashboard:products.images.notReady');

      const existing = await tx.productImage.count({ where: { productId: product.id } });

      await tx.productImage.upsert({
        where: { productId_mediaId: { productId: product.id, mediaId: media.id } },
        create: {
          tenantId: ctx.tenantId,
          productId: product.id,
          mediaId: media.id,
          alt,
          sort: existing,
          isPrimary: existing === 0,
        },
        update: { alt },
      });

      return null;
    },
    { actor: ctx.actor },
  );

  if (!state) await refreshStorefront(ctx.tenantId);
  return state;
}

export async function detachProductImage(
  ctx: MerchantContext,
  productImageId: string,
): Promise<ActionState | null> {
  const state = await withTenantTxn(
    ctx.tenantId,
    async (tx): Promise<ActionState | null> => {
      const image = await tx.productImage.findFirst({
        where: { id: productImageId, tenantId: ctx.tenantId },
        select: { id: true, productId: true, isPrimary: true },
      });
      if (!image) return failure('dashboard:errors.notFound');

      await tx.productImage.delete({ where: { id: image.id } });

      // Never leave a product with photos and no primary: A2 picks the primary for the card and
      // the OG image, and a gallery with no lead image renders the first thing it finds — which
      // is whichever row the planner returned.
      if (image.isPrimary) {
        const next = await tx.productImage.findFirst({
          where: { productId: image.productId, tenantId: ctx.tenantId },
          orderBy: { sort: 'asc' },
          select: { id: true },
        });
        if (next) await tx.productImage.update({ where: { id: next.id }, data: { isPrimary: true } });
      }

      return null;
    },
    { actor: ctx.actor },
  );

  if (!state) await refreshStorefront(ctx.tenantId);
  return state;
}

export async function makeImagePrimary(
  ctx: MerchantContext,
  productImageId: string,
): Promise<ActionState | null> {
  const state = await withTenantTxn(
    ctx.tenantId,
    async (tx): Promise<ActionState | null> => {
      const image = await tx.productImage.findFirst({
        where: { id: productImageId, tenantId: ctx.tenantId },
        select: { id: true, productId: true },
      });
      if (!image) return failure('dashboard:errors.notFound');

      await tx.productImage.updateMany({
        where: { productId: image.productId, tenantId: ctx.tenantId },
        data: { isPrimary: false },
      });
      await tx.productImage.update({ where: { id: image.id }, data: { isPrimary: true } });

      return null;
    },
    { actor: ctx.actor },
  );

  if (!state) await refreshStorefront(ctx.tenantId);
  return state;
}

// -----------------------------------------------------------------------------
// Categories
// -----------------------------------------------------------------------------

export const categorySchema = z.object({
  id: z.string().trim().optional(),
  name: requiredText(80, 2),
  key: optionalSlugField,
  published: z.boolean(),
  sort: integerField(0, 999),
});

export async function saveCategory(ctx: MerchantContext, raw: unknown): Promise<ActionState | null> {
  const parsed = categorySchema.safeParse(raw);
  if (!parsed.success) return invalid(parsed.error);

  const input = parsed.data;
  // The key is the storefront's stable handle and what B3's packs link products by, so it is
  // generated once and never rewritten from a renamed category.
  const key = input.key ?? slugCandidate(input.name, 'category', shortId(6));

  try {
    const state = await withTenantTxn(
      ctx.tenantId,
      async (tx): Promise<ActionState | null> => {
        if (input.id) {
          const before = await tx.category.findFirst({
            where: { id: input.id, tenantId: ctx.tenantId },
            select: { id: true },
          });
          if (!before) return failure('dashboard:errors.notFound');

          await tx.category.update({
            where: { id: input.id },
            data: { name: input.name, published: input.published, sort: input.sort },
          });
          return null;
        }

        await tx.category.create({
          data: {
            tenantId: ctx.tenantId,
            key,
            name: input.name,
            published: input.published,
            sort: input.sort,
          },
        });
        return null;
      },
      { actor: ctx.actor },
    );

    if (!state) await refreshStorefront(ctx.tenantId);
    return state;
  } catch (error) {
    const candidate = error as { code?: string } | null;
    if (candidate?.code === 'P2002') {
      return failure('dashboard:errors.validation', [
        { field: 'key', messageKey: 'dashboard:errors.slugTaken' },
      ]);
    }
    throw error;
  }
}

export async function deleteCategory(
  ctx: MerchantContext,
  categoryId: string,
): Promise<ActionState | null> {
  const state = await withTenantTxn(
    ctx.tenantId,
    async (tx): Promise<ActionState | null> => {
      const before = await tx.category.findFirst({
        where: { id: categoryId, tenantId: ctx.tenantId },
        select: { key: true, name: true },
      });
      if (!before) return failure('dashboard:errors.notFound');

      await auditInTx(tx, ctx, {
        action: 'category.deleted',
        entityType: 'category',
        entityId: categoryId,
        before,
      });

      // `Product.categoryId` is `onDelete: SetNull` — the products survive, uncategorised.
      await tx.category.delete({ where: { id: categoryId } });
      return null;
    },
    { actor: ctx.actor },
  );

  if (!state) await refreshStorefront(ctx.tenantId);
  return state;
}

export type { MediaView };
