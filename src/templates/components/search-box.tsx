/**
 * The storefront search box.
 *
 * A PLAIN GET FORM, and that is the whole design. No `'use client'`, no state, no fetch, no
 * debounce, no bundle: submitting navigates to `/search?q=…` and the server renders the results.
 * Exactly the reasoning behind the category filter in `src/app/site/products/page.tsx` — «on Fast
 * 3G a filter that needs a bundle to work is a filter that does not work» — and it holds harder
 * here, because search is the control a visitor reaches for when the page has already disappointed
 * them once.
 *
 * GET rather than POST so a result page is linkable, shareable, bookmarkable and back-buttonable,
 * which is what a customer actually does with a search they want to send to someone else.
 *
 * The labels arrive as props, already translated. Client or server, that is the pattern every
 * template component follows (see `components/announcement-bar.tsx`): the copy comes through the
 * i18n layer at the call site, never as a literal in here.
 */

import { SearchIcon } from './icons';

export interface SearchBoxLabels {
  /** The visible `<label>`. Never a placeholder standing in for one — a placeholder disappears. */
  field: string;
  placeholder: string;
  submit: string;
  /** `aria-label` for the landmark, so a screen-reader rotor can tell it from the nav. */
  region: string;
}

export interface SearchBoxProps {
  labels: SearchBoxLabels;
  /** The current query, so the box on a results page shows what was searched for. */
  defaultValue?: string;
  /** A results page already has an `h1`; the homepage section supplies its own heading. */
  id?: string;
  /**
   * The header variant: one row, no visible label, submit reduced to a magnifier.
   *
   * The label is still IN THE DOM and still bound to the input — moved off-screen by `.sf-vh`, not
   * removed. A placeholder is not a label: it disappears the moment someone types, so a visitor who
   * tabs back to a half-filled box has nothing telling them what it is, and voice control has no
   * name to address. This is the one place the box has no room for a visible one, which is exactly
   * the case the visually-hidden pattern exists for — the section variant keeps its label showing.
   */
  compact?: boolean;
}

export function SearchBox({
  labels,
  defaultValue = '',
  id = 'sf-search',
  compact = false,
}: SearchBoxProps) {
  return (
    /*
      `<form role="search">` rather than the newer `<search>` element: it is the landmark every
      screen reader and every axe version already understands, and one element means one landmark —
      wrapping a `role="search"` form in a `<search>` would announce the same region twice.
    */
    <div className={compact ? 'sf-search sf-search--compact' : 'sf-search'}>
      <form action="/search" method="get" role="search" aria-label={labels.region}>
        <label className={compact ? 'sf-vh' : 'sf-search__label'} htmlFor={id}>
          {labels.field}
        </label>
        <div className="sf-search__row">
          <input
            id={id}
            className="sf-input sf-search__input"
            type="search"
            name="q"
            defaultValue={defaultValue}
            placeholder={labels.placeholder}
            /**
             * `dir="auto"`, not `rtl`.
             *
             * The page is RTL and Arabic is the shipped locale, but this one field legitimately
             * receives Latin text — a brand name, a size, an SKU a customer was given over
             * WhatsApp. `auto` lets the browser take the direction from the first strong character,
             * so «فستان» and "Nike 42" both read correctly in the same input. Hardcoding `rtl` puts
             * the cursor and the punctuation of a Latin query in the wrong place.
             */
            dir="auto"
            /**
             * `maxLength` mirrors `MAX_SEARCH_TERM_LENGTH` on the server. It is a courtesy, not a
             * control: the server caps it again, because an attribute is a suggestion to a browser.
             */
            maxLength={64}
            autoComplete="off"
            enterKeyHint="search"
          />
          {/*
            The compact submit is a magnifier with the label as its accessible name, not an icon
            with no name: `aria-label` carries the word a screen reader announces and `title`
            carries the one a mouse user gets on hover. An icon button without both is a control
            announced as "button".
          */}
          <button
            type="submit"
            className="sf-btn sf-search__submit"
            aria-label={compact ? labels.submit : undefined}
            title={compact ? labels.submit : undefined}
          >
            {compact ? <SearchIcon className="sf-search__icon" /> : labels.submit}
          </button>
        </div>
      </form>
    </div>
  );
}
