import type {
  StorefrontCategory,
  StorefrontContext,
  StorefrontProduct,
  StorefrontSection,
} from '@/templates';

/**
 * The empty-catalogue fixture (Phase 11, Track 11.D).
 *
 * A merchant on their first day opens the preview with zero products, and a template compared
 * over a blank page is a colour swatch. This fills the frame with a SMALL Arabic sample —
 * labelled «محتوى تجريبي للمعاينة» by the appearance screen — so the comparison is of shops, not
 * of empty grids.
 *
 * DELIBERATELY NOT THE DEMO PACKS: another shop's demo products inside a merchant's own preview
 * is a confusing thing to show (the phase plan says exactly this), and the packs are B3's frozen
 * contract besides. Images are null on purpose — `MediaImage` renders the storefront's deliberate
 * no-image state, which is precisely what this merchant's real first day looks like, hatch and
 * all. Nothing here touches the database and nothing is stored.
 *
 * THE ARABIC BELOW STAYS HERE, not in `messages/ar/appearance.json`, and that is a decision
 * rather than an oversight. CLAUDE.md routes user-facing COPY through the i18n layer; this is
 * fixture CONTENT — the same species as `src/server/demo/packs/*.json`, which has held Arabic
 * product names outside `messages/` since B3. A shop name is not a label: translating it would
 * mean inventing a different shop, and the platform ships one locale by policy. The labels
 * AROUND the fixture — the «محتوى تجريبي للمعاينة» caption and every control on the appearance
 * screen — do go through `appearance.json`, which is where the rule actually bites.
 */

const SAMPLE_CATEGORIES: StorefrontCategory[] = [
  { key: 'sample-basics', name: 'الأساسيات', productCount: 2, image: null },
  { key: 'sample-new', name: 'وصل حديثاً', productCount: 2, image: null },
  { key: 'sample-offers', name: 'عروض الأسبوع', productCount: 2, image: null },
];

function product(
  index: number,
  name: string,
  description: string,
  priceAgorot: number,
  categoryIndex: number,
  badge: string | null = null,
): StorefrontProduct {
  const category = SAMPLE_CATEGORIES[categoryIndex]!;
  return {
    id: `preview-sample-${index}`,
    slug: `preview-sample-${index}`,
    name,
    description,
    priceAgorot,
    available: true,
    badge,
    sku: `SB-10${index}`,
    categoryKey: category.key,
    categoryName: category.name,
    image: null,
    images: [],
  };
}

const SAMPLE_PRODUCTS: StorefrontProduct[] = [
  product(1, 'زيت زيتون بلدي — تنكة 1 لتر', 'عصرة أولى على البارد من كروم المنطقة.', 6500, 0),
  product(2, 'زعتر بلدي ناعم', 'خلطة البيت مع سمسم محمّص.', 1800, 0, 'الأكثر طلباً'),
  product(3, 'طقم فناجين قهوة — 6 قطع', 'خزف مشغول بنقشة تراثية.', 8900, 1),
  product(4, 'شال صوف شتوي', 'صوف ناعم بألوان دافئة، مناسب للهدايا.', 12000, 1, 'جديد'),
  product(5, 'صابون زيت زيتون — 3 قطع', 'صناعة يدوية بدون عطور صناعية.', 2400, 2),
  product(6, 'سلة هدايا العيد', 'تشكيلة مختارة بتغليف جاهز للإهداء.', 15900, 2, 'عرض'),
];

const SAMPLE_SECTIONS: StorefrontSection[] = [
  { id: 'preview-hero', type: 'hero', sort: 0, config: {} },
  { id: 'preview-categories', type: 'categories', sort: 1, config: {} },
  { id: 'preview-products', type: 'products_grid', sort: 2, config: {} },
  { id: 'preview-contact', type: 'contact_whatsapp', sort: 3, config: {} },
];

/**
 * Overlay the sample onto a real (empty) context. Products and their counts always; categories
 * and sections only when the tenant genuinely has none, so a shop with real departments and no
 * items previews ITS departments over sample items.
 */
export function withSampleCatalogue(context: StorefrontContext): StorefrontContext {
  if (context.productTotal > 0) return context;

  const categories = context.categories.length > 0 ? context.categories : SAMPLE_CATEGORIES;
  const sections = context.sections.length > 0 ? context.sections : SAMPLE_SECTIONS;

  return {
    ...context,
    categories,
    sections,
    products: SAMPLE_PRODUCTS,
    productTotal: SAMPLE_PRODUCTS.length,
    productCountByCategory: Object.fromEntries(
      SAMPLE_CATEGORIES.map((category) => [category.key, category.productCount]),
    ),
    productsByCategory: {},
  };
}
