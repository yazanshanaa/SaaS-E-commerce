import { translator } from '@/shared/i18n';
import type { StorefrontCategory } from '../view-model';

const ct = translator('content');

/**
 * The shop's departments, in the header.
 *
 * `site-header.tsx` opens with a decision this component has to respect rather than quietly undo:
 * *there is no mega-menu and no search — a merchant in Bartaa has between six and forty products, and a
 * navigation bar with more entries than the shop has categories is chrome pretending to be a feature.*
 *
 * So this is a FLAT LINK LIST and nothing else:
 *   - no dropdown, and therefore no JavaScript, no focus management, no escape handler, and no
 *     `aria-expanded` that can disagree with what is on screen;
 *   - no nesting. `Category` has no parent column, so a hierarchy would have to be invented from
 *     names;
 *   - CAPPED. Past the cap the tail collapses into one link to the catalogue, because a header with
 *     fourteen department links is the mega-menu the header refused, spelled differently.
 *
 * It renders NOTHING for a shop with one category. A single «قسم» link beside «كل المنتجات» is two
 * routes to the same page, and the header already has the second one.
 */

/**
 * Six.
 *
 * It is the number that fits one line beside the brand on a 360px viewport before wrapping, which is
 * the constraint that actually decides — a seventh link pushes the row under the logo and the header
 * grows by 44px on every page of the shop, which is CLS the storefront budget does not have.
 */
export const CATEGORY_NAV_CAP = 6;

/**
 * Would `CategoryNav` draw anything for these categories?
 *
 * Exported so the header can decide whether to paint the BAND the chips sit on. The band has a
 * rule and vertical padding of its own, so wrapping a component that returns null gives every
 * one-category boutique an empty bordered strip under its header — and `:empty` cannot see it,
 * because the wrapper still contains the layout shell div.
 *
 * The predicate is the first two lines of the component and has to stay that way; it is asserted
 * against it rather than re-derived.
 */
export function hasCategoryNav(categories: StorefrontCategory[]): boolean {
  return categories.filter((category) => category.productCount > 0).length >= 2;
}

export interface CategoryNavProps {
  categories: StorefrontCategory[];
  /** Which category page is current, for `aria-current`. */
  currentKey?: string | null;
  limit?: number;
}

export function CategoryNav({ categories, currentKey, limit = CATEGORY_NAV_CAP }: CategoryNavProps) {
  /**
   * Empty categories are dropped BEFORE the cap is applied.
   *
   * `context.categories` carries every published category with its true count over the whole
   * catalogue, and a department with nothing in it renders «ما في منتجات بهذا القسم» — so putting it in
   * the header spends one of six slots on a dead end. Filtering after the cap would silently show four
   * links where six were available.
   */
  const stocked = categories.filter((category) => category.productCount > 0);
  if (stocked.length < 2) return null;

  const shown = stocked.slice(0, Math.max(1, limit));
  const overflow = stocked.length > shown.length;

  return (
    <nav className="sf-catnav" aria-label={ct('nav.categories')}>
      <ul className="sf-chips">
        {shown.map((category) => (
          <li key={category.key}>
            <a
              href={`/products?category=${encodeURIComponent(category.key)}`}
              aria-current={currentKey === category.key ? 'page' : undefined}
            >
              {category.name}
            </a>
          </li>
        ))}

        {overflow ? (
          <li>
            <a href="/products">{ct('nav.allCategories')}</a>
          </li>
        ) : null}
      </ul>
    </nav>
  );
}
