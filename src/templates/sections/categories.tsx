import type { SectionConfig } from '@/shared/site-contract';
import { MediaImage } from '../components/media-image';
import { pluralCount, st } from '../i18n';
import { SECTION_ANCHORS } from '../section-anchors';
import type { StorefrontContext } from '../view-model';
import { SectionBlock } from './block';

/**
 * Categories, in the shape the template calls for.
 *
 *   tiles (ديوان)     square tiles with a picture — a shop you walk around;
 *   rail  (سوق نيون)  a horizontally snapping rail — a shop you scroll past;
 *   index (ورشة)      a compact list with counts — a catalogue you look things up in.
 *
 * `config.style = 'chips'` overrides all three with a flat chip row: a merchant with fourteen
 * categories and no category images gets something usable instead of fourteen empty tiles.
 */

export interface CategoriesSectionProps {
  context: StorefrontContext;
  config: SectionConfig<'categories'>;
  /** Unique-per-page override from `SectionList`; falls back to the type's stable anchor. */
  anchor?: string;
}

export function CategoriesSection({ context, config, anchor }: CategoriesSectionProps) {
  const categories = context.categories.slice(0, config.limit ?? 8);
  const title = config.title?.trim() || st('sections.categories');
  const variant = config.style === 'chips' ? 'chips' : context.template.layout.categories;

  if (categories.length === 0) {
    return (
      <SectionBlock anchor={anchor ?? SECTION_ANCHORS.categories} title={title}>
        <p className="sf-note">{st('categories.empty')}</p>
      </SectionBlock>
    );
  }

  return (
    <SectionBlock anchor={anchor ?? SECTION_ANCHORS.categories} title={title}>
      {variant === 'index' ? (
        <ul className="sf-index">
          {categories.map((category) => (
            <li key={category.key}>
              <a href={`/products?category=${encodeURIComponent(category.key)}`}>
                <span>{category.name}</span>
                <span className="sf-cat__count">
                  {pluralCount('categories.productCount', category.productCount)}
                </span>
              </a>
            </li>
          ))}
        </ul>
      ) : variant === 'chips' ? (
        /* `.sf-chips`, not `.sf-social`: the social row is a fixed 44x44 icon target, so borrowing
           it put every category NAME inside a circle the size of an icon — and `.sf-social a` at
           (0,1,1) beats `.sf-btn` at (0,1,0), so the button class could not undo it. Arabic
           category names are words, not glyphs. */
        <ul className="sf-chips" aria-label={title}>
          {categories.map((category) => (
            <li key={category.key}>
              <a
                className="sf-btn sf-btn--ghost"
                href={`/products?category=${encodeURIComponent(category.key)}`}
              >
                {category.name}
              </a>
            </li>
          ))}
        </ul>
      ) : (
        <ul className={variant === 'rail' ? 'sf-rail' : 'sf-cats'}>
          {categories.map((category) => (
            <li key={category.key}>
              <a className="sf-cat" href={`/products?category=${encodeURIComponent(category.key)}`}>
                <MediaImage
                  image={category.image}
                  ratio={variant === 'rail' ? '4 / 3' : '1 / 1'}
                  fallbackLabel={category.name}
                  sizes="(max-width: 40rem) 50vw, 20vw"
                />
                <span className="sf-cat__label">
                  <span>{category.name}</span>
                  <span className="sf-cat__count">
                    {pluralCount('categories.productCount', category.productCount)}
                  </span>
                </span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </SectionBlock>
  );
}
