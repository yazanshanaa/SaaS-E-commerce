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
}

export function SearchBox({ labels, defaultValue = '', id = 'sf-search' }: SearchBoxProps) {
  return (
    /*
      `<form role="search">` rather than the newer `<search>` element: it is the landmark every
      screen reader and every axe version already understands, and one element means one landmark —
      wrapping a `role="search"` form in a `<search>` would announce the same region twice.
    */
    <div className="sf-search">
      <form action="/search" method="get" role="search" aria-label={labels.region}>
        <label className="sf-search__label" htmlFor={id}>
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
          <button type="submit" className="sf-btn sf-search__submit">
            {labels.submit}
          </button>
        </div>
      </form>
    </div>
  );
}
