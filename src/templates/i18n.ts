import { translator } from '@/shared/i18n';

/**
 * Bound translators for the storefront.
 *
 * Every string a visitor reads comes through one of these — including Arabic ones. A hardcoded
 * Arabic literal in a component is as much a failure as an English one: the i18n layer cannot
 * reach it, so a second locale would have to hunt through JSX to find it (CLAUDE.md).
 *
 * SERVER SIDE ONLY. Importing `@/shared/i18n` into a client component would pull all seven
 * message namespaces — admin, dashboard, billing and the rest — into the storefront bundle, on
 * a page with a Fast 3G LCP budget. Client components receive already-translated labels as
 * props instead; see `components/announcement-bar.tsx` for the pattern.
 */
export const st = translator('storefront');
export const ct = translator('common');

/**
 * Arabic counts agree with the number. English does not, so an interpolated `{count} منتج`
 * template reads as broken Arabic on most of its range.
 *
 * The rule, and every branch is reachable on a real shop:
 *
 *   0        لا شيء            "ما في منتجات"      — the empty catalogue, every new account
 *   1        singular          "منتج واحد"
 *   2        dual              "منتجين"            — Arabic has a distinct dual; "2 منتج" is wrong
 *   3-10     sound plural      "5 منتجات"          — the most common case for a small shop
 *   11+      singular again    "24 منتج"           — counter-intuitive to a non-Arabic reader,
 *                                                    and exactly why this cannot be one template
 *
 * `Intl.PluralRules('ar')` returns these same six categories, but its `two` and `few` boundaries
 * are what CLDR says rather than what a shop owner writes, and the zero case wants a different
 * SENTENCE ("ما في منتجات") rather than a number with a noun after it. Five explicit keys are
 * clearer to translate and impossible to get subtly wrong.
 */
export function pluralCount(prefix: string, count: number): string {
  if (count === 0) return st(`${prefix}.zero`);
  if (count === 1) return st(`${prefix}.one`);
  if (count === 2) return st(`${prefix}.two`);
  if (count >= 3 && count <= 10) return st(`${prefix}.few`, { count });
  return st(`${prefix}.many`, { count });
}
