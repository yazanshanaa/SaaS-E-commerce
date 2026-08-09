# Demo data packs — Souq Bartaa

Three ready packs for phase B3 (Demo generator): **clothing / industrial / food**. Each contains a full shop identity, 5 categories, 15 products with realistic shekel prices, an announcement bar, the site sections, and 3 testimonials. All names and numbers are fictional.

**Language rule:** this documentation and all code are English. **All pack content is Arabic and stays Arabic** — it renders directly on Arabic-only storefronts, so treat it as production copy, not sample text.

## File map and where it goes

Copy the contents of this folder into `src/server/demo/` in the repo:

```
src/server/demo/
├── types.ts            # the fixed contract — B3 consumes it literally
├── placeholder.ts      # SVG image generator (zero dependencies)
└── packs/
    ├── clothing.json   # بوتيك ليان — neon-souq template
    ├── industrial.json # مؤسسة البناء الحديث — warsheh template
    └── food.json       # سوبر ماركت الوادي — diwan template
```

## Integration contract (how B3 consumes a pack)

1. Create the tenant: identity from `tenant`, slug = `{slugPrefix}-{shortId}`, template from `template`, colors from `colors` (passed through the contrast guard like any colors). If `announcementBar` is present, enable the site's top announcement bar with its text.
2. Create the categories, then the products (linked via `category` → `categories[].key`).
3. **Images:** if a real file `seed-assets/{pack}/{sku}.(jpg|png|webp)` exists, use it; otherwise generate an SVG via `svgPlaceholder(pack, name, sku)`. **Both paths go through the A3 media pipeline** to produce variants — external image URLs are never allowed.
4. Create the sections in `sort` order and the testimonials, then issue the magic link.
5. `imageAlt` is mandatory and is carried through as-is to the alt attribute (A3 policy).

## Operational notes

- **WhatsApp and phone numbers are placeholders** (`+972500000000`). Replace them with your own number before sending a demo to a client if you want the WhatsApp button to actually work, or leave them (demos are watermarked anyway).
- **Arabic font in Docker:** Sharp/librsvg rasterizes SVG using system fonts — add to the Dockerfile:
  `RUN apt-get install -y --no-install-recommends fonts-noto-core`
  otherwise Arabic text in generated images renders as boxes.
- To add real photos later: drop files named after the SKU into `seed-assets/{pack}/` — no code changes needed.
- These packs are data only. If the shape of a section `config` changes, align it with the A2 section schema rather than altering this contract.

## Updated B3 prompt (use this instead of the version in the kit)

```
Execute B3 — Demo generator (updated version, using the ready-made packs):

- The data lives in src/server/demo/packs/*.json following the contract in
  src/server/demo/types.ts — do not invent data, consume the packs as they are.
  Pack content is Arabic and must stay Arabic.
- A Super Admin button: pick a pack (clothing/industrial/food) -> create a demo tenant:
  slug = {slugPrefix}-{shortId}, template and colors from the pack, then categories,
  products, sections, announcement bar, and testimonials.
- Product images: if seed-assets/{pack}/{sku}.* exists use it, otherwise generate an SVG
  via svgPlaceholder() from src/server/demo/placeholder.ts — in both cases push the image
  through the A3 media pipeline to produce variants. No external image URLs.
  imageAlt is carried through as-is.
- A magic link with a 7-day expiry (adjustable) + a "نسخة تجريبية" watermark on the site
  + full noindex (meta robots + X-Robots-Tag + robots.txt) so demos are never indexed
  + a "convert to a real subscription" action that preserves all data.
- Automatic cleanup of expired demos.

Acceptance: a complete demo (15 products with image variants) in under 30 seconds,
with a link ready to send over WhatsApp.
```
