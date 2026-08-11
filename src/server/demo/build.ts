import type { DemoContentBuilder, DemoContentResult } from '@/server/billing/demo-content';
import { demoPack } from '@/server/billing/demo-packs';
import { logger } from '@/server/logger';
import { COLOR_PRESETS, resolveColors } from '@/shared/site-contract';
import { createDemoImageWriter } from './images';
import { buildSectionRows } from './sections';
import type { DemoPack } from './types';

/**
 * B3 — the demo CONTENT.
 *
 * `billing.createDemo()` has already written the Tenant, the Subscription on the hidden `demo`
 * plan, the Site from the pack's identity block (with the REQUESTER's address and WhatsApp when the
 * demo came from the public form) and the login-disabled owner. It then opens `withTenantTxn` and
 * hands the transaction here. Everything below commits with the magic link or not at all — a
 * half-built demo is a shareable link to a broken shop, which is the one failure a demo cannot have.
 *
 * The order is the pack contract's own (`src/server/demo/README.md`):
 *   theme -> page -> categories -> products (+ images) -> sections -> announcement bar -> testimonials
 *
 * Two things deliberately do NOT happen inside the transaction, and both are returned instead:
 *   - the variant-processing jobs, which would race the commit (`afterCommit`),
 *   - nothing else. Every row above is written on `tx`.
 *
 * `src/server/demo/packs/**`, `types.ts` and `placeholder.ts` are frozen. This file consumes them
 * literally; where a pack key and the site contract disagree, the adaptation lives in
 * `./sections.ts` and is recorded in `docs/decisions/b3.md` rather than fixed by editing either.
 */

/** The storefront reads sections from the page with this slug (`src/app/site/_data/context.ts`). */
const HOME_PAGE_SLUG = 'home';

export const buildDemoContent: DemoContentBuilder = async ({
  tx,
  tenantId,
  siteId,
  packKey,
  requester,
}) => {
  // Throws `UnknownDemoPackError` rather than falling back: a demo of the wrong trade is worse
  // than no demo, and `createDemo` unwinds the tenant it had already created.
  const pack: DemoPack = demoPack(packKey);
  const images = await createDemoImageWriter(tx, tenantId, pack.pack);

  try {
    await writeTheme(tx, tenantId, pack);

    const pageId = await writeHomePage(tx, tenantId, pack);
    const categoryIdByKey = await writeCategories(tx, tenantId, pack);
    const products = await writeProducts(tx, tenantId, pack, categoryIdByKey, images);
    const sections = await writeSections(tx, tenantId, pageId, pack, requester?.address);

    await writeAnnouncementBar(tx, siteId, pack);
    const testimonials = await writeTestimonials(tx, tenantId, pack);

    await images.commitUsage();

    logger().info(
      { tenantId, packKey, products, sections, testimonials },
      'demo content built',
    );

    const result: DemoContentResult = {
      categories: Object.keys(categoryIdByKey).length,
      products,
      sections,
      testimonials,
      mediaIds: images.mediaIds(),
      afterCommit: () => images.enqueueProcessing(),
    };

    return result;
  } catch (error) {
    /**
     * The rows unwind with the transaction; the OBJECTS do not.
     *
     * `createDemo`'s catch deletes the tenant, so nothing would ever look under this prefix again
     * and A3's orphan sweep would be the only thing that ever collected them. Taking them back
     * here makes the failure clean instead of merely eventually clean.
     */
    await images.discardObjects();
    throw error;
  }
};

type Tx = Parameters<DemoContentBuilder>[0]['tx'];

/**
 * Colours from the pack, through the WCAG AA guard like any other colour write (CLAUDE.md design
 * rules; `resolveColors` is the same function B2's picker and A2's loader both call).
 *
 * `createDemo` writes the Site but not the theme, so without this row the storefront falls back to
 * the template's own tokens — which happens to look nearly right, because the packs and the
 * templates were designed together, and would go quietly wrong the day either moved.
 */
async function writeTheme(tx: Tx, tenantId: string, pack: DemoPack): Promise<void> {
  /**
   * EACH PACK'S THREE COLOURS ARE EXACTLY ONE OF THE FIVE VETTED PRESETS, and recognising that is
   * worth more than it looks.
   *
   *   clothing  #E11D48 / #F4C95D / #0F0B10  -> ليلي
   *   industrial #F59E0B / #8A93A3 / #171B21 -> فولاذ
   *   food      #C2410C / #5F6F3E / #FAF3E7  -> صحراء
   *
   * A preset carries FIVE tokens; a custom selection carries three, and `resolveColors` then fills
   * `surface` from `background` and picks `text` by lightness. For the food pack that turns a white
   * card surface (#FFFFFF) into the cream page background (#FAF3E7) — every panel on the demo stops
   * being a panel, on the shop we are showing a customer. Storing the preset keeps the palette its
   * author actually vetted, and it costs nothing: the guard still runs on read, and the merchant who
   * converts inherits a NAMED palette they can switch away from rather than three loose hex values.
   *
   * Matched by COLOUR, never by typing a key: one of the five is `laylī` with U+012B, and a typo
   * would fail the schema's refinement with an Arabic message nobody is there to read. A pack that
   * stops matching simply falls back to custom.
   */
  const preset = COLOR_PRESETS.find(
    (candidate) =>
      candidate.primary.toLowerCase() === pack.colors.primary.toLowerCase() &&
      candidate.secondary.toLowerCase() === pack.colors.secondary.toLowerCase() &&
      candidate.background.toLowerCase() === pack.colors.background.toLowerCase(),
  );

  if (preset) {
    const { colors: presetColors, adjustments: presetAdjustments } = resolveColors({
      mode: 'preset',
      presetKey: preset.key,
    });
    // The presets are vetted, so this should never fire — which is exactly why it is worth logging.
    if (presetAdjustments.length > 0) {
      logger().warn(
        { tenantId, presetKey: preset.key, adjustments: presetAdjustments.map((a) => a.token) },
        'a vetted colour preset needed a contrast adjustment',
      );
    }

    await tx.themeSettings.create({
      data: {
        tenantId,
        colorMode: 'preset',
        presetKey: preset.key,
        primary: presetColors.primary,
        secondary: presetColors.secondary,
        background: presetColors.background,
        surface: presetColors.surface,
        text: presetColors.text,
      },
    });
    return;
  }

  const { colors, adjustments } = resolveColors({
    mode: 'custom',
    primary: pack.colors.primary,
    secondary: pack.colors.secondary,
    background: pack.colors.background,
  });

  if (adjustments.length > 0) {
    // Nobody is watching a form here, so the notice goes to the log: a pack whose colours need
    // moving is a fact about the frozen data worth surfacing at review time.
    logger().info(
      { tenantId, pack: pack.pack, adjustments: adjustments.map((a) => a.token) },
      'demo colours adjusted by the contrast guard',
    );
  }

  /**
   * The fallback: three columns, because a custom selection declares three colours.
   *
   * `surface` and `text` stay null and A2's loader re-derives them with the same `resolveColors()`
   * on every read, so storing the derived values would change nothing on screen while claiming the
   * pack chose two colours it never mentions. (That derivation — `surface = background` — is the
   * flattening the preset branch above exists to avoid; it affects every tenant on custom colours,
   * not only demos, and is raised as a finding in `docs/decisions/b3.md`.)
   */
  await tx.themeSettings.create({
    data: {
      tenantId,
      colorMode: 'custom',
      primary: colors.primary,
      secondary: colors.secondary,
      background: colors.background,
    },
  });
}

/**
 * The home page the sections hang off.
 *
 * `Section.pageId` is NOT NULL, and the storefront reads `page.slug = 'home'` — so a demo without
 * this row renders a site with no sections at all, which is exactly the "shareable link to an empty
 * shop" the placeholder in this file used to guard against. `isSystem` matches A1's
 * `seedDefaultSections`, so the page is not deletable from the merchant side after a conversion.
 */
async function writeHomePage(tx: Tx, tenantId: string, pack: DemoPack): Promise<string> {
  const page = await tx.page.create({
    data: {
      tenantId,
      slug: HOME_PAGE_SLUG,
      title: pack.tenant.name,
      isSystem: true,
      published: true,
      sort: 0,
    },
    select: { id: true },
  });

  return page.id;
}

async function writeCategories(
  tx: Tx,
  tenantId: string,
  pack: DemoPack,
): Promise<Record<string, string>> {
  const idByKey: Record<string, string> = {};

  for (const [index, category] of pack.categories.entries()) {
    const row = await tx.category.create({
      data: {
        tenantId,
        key: category.key,
        name: category.name,
        sort: index,
        published: true,
      },
      select: { id: true },
    });
    idByKey[category.key] = row.id;
  }

  return idByKey;
}

/**
 * Products, linked through `category` -> `categories[].key` (the contract, step 2).
 *
 * A product whose category key is not in the pack would silently become an uncategorised product
 * that no category chip can reach, so it is a hard failure instead: the packs are frozen data and a
 * dangling key in them is a bug to fix at the source, not to absorb at 3 a.m.
 *
 * SLUG IS THE SKU. `Product.slug` is unique per tenant and ends up in a URL; the pack names are
 * Arabic, and percent-encoding "عباية مطرزة كلاسيك" into a path produces a link nobody can read
 * back to the admin over the phone. The SKU is already unique within a pack and already ASCII.
 *
 * PRICE IS AGOROT. The packs quote whole shekels (189); the column is `price_agorot` and no float
 * ever touches it.
 */
async function writeProducts(
  tx: Tx,
  tenantId: string,
  pack: DemoPack,
  categoryIdByKey: Record<string, string>,
  images: Awaited<ReturnType<typeof createDemoImageWriter>>,
): Promise<number> {
  let written = 0;

  for (const [index, product] of pack.products.entries()) {
    const categoryId = categoryIdByKey[product.category];
    if (!categoryId) {
      throw new Error(
        `Pack ${pack.pack}: product ${product.sku} names category "${product.category}", which the ` +
          'pack does not declare. The packs are frozen — raise it in the main session.',
      );
    }

    const image = await images.write(product);

    const row = await tx.product.create({
      data: {
        tenantId,
        categoryId,
        sku: product.sku,
        slug: product.sku,
        name: product.name,
        description: product.description,
        priceAgorot: Math.round(product.price * 100),
        currency: product.currency,
        available: product.available,
        badge: product.badge ?? null,
        sort: index,
        published: true,
      },
      select: { id: true },
    });

    await tx.productImage.create({
      data: {
        tenantId,
        productId: row.id,
        mediaId: image.mediaId,
        // Carried through as-is from the pack (A3 policy), after the shared normalisation every
        // other writer of a ProductImage goes through.
        alt: image.alt,
        sort: 0,
        isPrimary: true,
      },
    });

    written += 1;
  }

  return written;
}

async function writeSections(
  tx: Tx,
  tenantId: string,
  pageId: string,
  pack: DemoPack,
  requesterAddress: string | undefined,
): Promise<number> {
  const rows = buildSectionRows(pack, { address: requesterAddress });

  for (const row of rows) {
    await tx.section.create({
      data: {
        tenantId,
        pageId,
        type: row.type,
        sort: row.sort,
        enabled: true,
        config: row.config as object,
      },
    });
  }

  return rows.length;
}

/**
 * The site-level bar, not a section (`announcementBar` in the pack, `Site.announcement_bar_*` in
 * the schema). Left unscheduled on purpose: a demo has no season, and a start date would make the
 * bar invisible on the day the link is sent.
 */
async function writeAnnouncementBar(tx: Tx, siteId: string, pack: DemoPack): Promise<void> {
  if (!pack.announcementBar) return;

  await tx.site.update({
    where: { id: siteId },
    data: {
      announcementBarEnabled: true,
      announcementBarText: pack.announcementBar.text,
      announcementBarLink: pack.announcementBar.link ?? null,
    },
  });
}

async function writeTestimonials(tx: Tx, tenantId: string, pack: DemoPack): Promise<number> {
  for (const [index, testimonial] of pack.testimonials.entries()) {
    await tx.testimonial.create({
      data: {
        tenantId,
        name: testimonial.name,
        text: testimonial.text,
        sort: index,
        published: true,
      },
    });
  }

  return pack.testimonials.length;
}
