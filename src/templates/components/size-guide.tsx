import { translator } from '@/shared/i18n';

const ct = translator('catalogue');

/**
 * «جدول المقاسات», as a native `<details>`.
 *
 * `<details>` rather than a scripted accordion, for the same reason `variant-picker.tsx` uses
 * radios: the element already opens on click AND on enter, already exposes the expanded state to
 * assistive technology, already works with the page's find-in-page, and costs zero bytes of
 * JavaScript on a storefront whose LCP budget is written for Fast 3G. Every hand-rolled
 * disclosure on the web is an attempt to reproduce this element badly.
 *
 * A `<table>` inside it, and a real one — with `<th scope="col">` and `<th scope="row">`. The
 * measurements ARE tabular data: «الصدر» of «M» is the cell where a row and a column meet, which
 * is the one thing a table element says and a grid of divs cannot.
 */

export interface SizeGuideRow {
  id: string;
  /** «M», «42» — the row header. */
  label: string;
  /** Parallel to `columns`. Shorter is allowed; the renderer pads. */
  cells: string[];
}

export interface SizeGuideProps {
  /** «الصدر · الخصر · الطول». Empty means there is no chart to draw. */
  columns: string[];
  rows: SizeGuideRow[];
  note?: string | null;
  /** Open on first paint. Off by default — the chart is a reference, not the page's content. */
  defaultOpen?: boolean;
}

/**
 * An em dash for a cell the merchant has not filled in.
 *
 * An EMPTY cell would be the honest markup and is the wrong choice here: a blank `<td>` in the
 * middle of a measurements table reads as a rendering failure to a sighted user and as silence to
 * a screen reader, so a shopper cannot tell "we did not measure this" from "the table is broken".
 */
const MISSING_CELL = '—';

export function SizeGuide({ columns, rows, note, defaultOpen = false }: SizeGuideProps) {
  if (columns.length === 0 || rows.length === 0) return null;

  return (
    /*
      `.sf-note` (a bordered card) on the details and `.sf-prose` on the body, rather than a new
      class of its own. Every class here already exists in `src/templates/storefront.css` —
      `.sf-prose table` is the only table styling the storefront has, and inventing `.sf-disclosure`
      from a track that does not own the stylesheet would ship markup hooked to CSS nobody wrote.
      The dedicated treatment is Track F's, and it is listed in the handoff.
    */
    <details className="sf-note" open={defaultOpen}>
      <summary className="sf-link">{ct('sizeGuide.open')}</summary>

      <div className="sf-prose">
        <table>
          <caption>{ct('sizeGuide.caption')}</caption>
          <thead>
            <tr>
              <th scope="col">{ct('sizeGuide.sizeColumn')}</th>
              {columns.map((column, index) => (
                <th scope="col" key={`${column}-${index}`}>
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <th scope="row">{row.label}</th>
                {/*
                  Iterating the COLUMNS and indexing into the cells, never mapping the cells: a row
                  with three measurements under four headers must render four `<td>`s or every cell
                  after the gap shifts one column left, which silently relabels a waist as a length.
                */}
                {columns.map((column, index) => (
                  <td key={`${row.id}-${column}-${index}`}>{cellText(row.cells[index])}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>

        {note ? <p>{note}</p> : null}
      </div>
    </details>
  );
}

function cellText(value: string | undefined): string {
  const trimmed = (value ?? '').trim();
  return trimmed === '' ? MISSING_CELL : trimmed;
}
