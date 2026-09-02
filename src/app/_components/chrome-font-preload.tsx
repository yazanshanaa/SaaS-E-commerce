/**
 * The two chrome faces, preloaded — on the PRIVATE surfaces only.
 *
 * `@font-face` alone does not start a download until the layout engine matches a glyph to the
 * family, which on a text-heavy Arabic page lands one round trip AFTER first paint: the merchant
 * reads a screenful of fallback and then watches it reflow. These two are needed by the first
 * painted character of the admin panel and the merchant dashboard, so they are fetched in parallel
 * with the CSS instead of after it.
 *
 * WHY THIS IS A COMPONENT AND NOT TWO LINES IN THE ROOT LAYOUT, which is where it used to live.
 *
 * `src/app/layout.tsx` is shared by all three surfaces and is synchronous by design — it cannot
 * know which surface is rendering without becoming dynamic and opting the whole application out of
 * static rendering. So the preload it emitted for "every private surface" (its own words) went out
 * on STOREFRONTS too, where neither face is ever used. A storefront then carried three preloaded
 * fonts: these two, plus the active template's face from `templates/shell.tsx` — whose header says,
 * about exactly this, "Preloading three families would spend the Fast 3G budget on two fonts nobody
 * will see."
 *
 * `tests/e2e/a2-storefront.spec.ts` pins one (`Expected length: 1, Received length: 3`) and had
 * been failing since the storefront budget was written. It is CLAUDE.md's budget: LCP < 2.5s on
 * Fast 3G, fonts subset and preloaded — two unused Arabic faces on the critical path is a real
 * cost on a real phone in Bartaa, not a test detail.
 *
 * React hoists `<link>` into `<head>` from anywhere in the tree, so a preload declared by the
 * layout that actually uses the font lands in exactly the same place — and can no longer reach a
 * surface that does not.
 */
export function ChromeFontPreload() {
  return (
    <>
      <link
        rel="preload"
        as="font"
        type="font/woff2"
        crossOrigin="anonymous"
        href="/fonts/ibm-plex-sans-arabic/ibm-plex-sans-arabic-v15-arabic-regular.woff2"
      />
      <link
        rel="preload"
        as="font"
        type="font/woff2"
        crossOrigin="anonymous"
        href="/fonts/alexandria/alexandria-v6-arabic-700.woff2"
      />
    </>
  );
}
