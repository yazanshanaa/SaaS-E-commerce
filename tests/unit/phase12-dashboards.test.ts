import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Phase 12's machine gate for the parts no browser is needed to judge.
 *
 * TWO DASHBOARD DEFECTS that render as "a bit off" rather than as an error — both found by LOOKING
 * at a screenshot, which is exactly why they are written down here: neither produces a parse error,
 * a console warning, a type error or a failing assertion anywhere else, and both had been shipping
 * since the kit landed.
 *
 * And THE CATALOGUE'S ORDER CONTROL (12.B), whose risk is not the SQL — Prisma types that — but the
 * four rules that make a URL-driven control behave: a closed set, a stable tie-break, a canonical
 * default, and every link carrying the state the others set.
 *
 * (The filename says `dashboards` because that is what it started as. Kept rather than renamed: a
 * test file's path appears in three years of `git log` and in the report of every gate that ever
 * failed, and a rename to tidy a name costs more than the name does.)
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const SHEET_FILES = [
  'src/app/globals.css',
  'src/app/kit.css',
  'src/app/dashboard/dashboard.css',
  'src/app/dashboard/appearance/appearance.css',
  'src/app/admin/admin.css',
];

const SHEETS = SHEET_FILES.map((file) => ({
  file,
  source: readFileSync(path.join(repoRoot, file), 'utf8'),
}));

/**
 * COMMENTS BLANKED, NOT STRIPPED — line numbers have to survive so a failure names the right line.
 *
 * Necessary in both directions, and the second one bit immediately: the note explaining the
 * `--sb-space-5` defect *quotes the broken declaration*, so a scanner reading raw source would have
 * failed on the comment that documents the fix. A commented-out definition must not count as one
 * either.
 */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '));
}

const CODE = SHEETS.map(({ file, source }) => ({ file, source: withoutComments(source) }));

/** Everything the five sheets DEFINE, unioned — `--sbx-*` is declared in one file and read in another. */
function definedTokens(): Set<string> {
  const defined = new Set<string>();
  for (const { source } of CODE) {
    for (const match of source.matchAll(/(--sb[a-z]*-[a-z0-9-]+)\s*:/gi)) {
      // `match[1]` is `string | undefined` under strict: a capturing group can legally not
      // participate. It always does here, but the guard costs nothing and TS is right to ask.
      const name = match[1];
      if (name) defined.add(name.toLowerCase());
    }
  }
  return defined;
}

/**
 * Every `var(--sb…)` READ, minus the ones that carry a fallback.
 *
 * A fallback makes an undefined property harmless — `var(--x, 8px)` resolves — so those are not
 * the bug and flagging them would train the next person to ignore this test.
 */
function referencedTokens(source: string): Array<{ token: string; line: number }> {
  const found: Array<{ token: string; line: number }> = [];

  source.split('\n').forEach((text, index) => {
    for (const match of text.matchAll(/var\(\s*(--sb[a-z]*-[a-z0-9-]+)\s*([^)]*)\)/gi)) {
      const name = match[1];
      const rest = match[2] ?? '';
      if (!name || rest.trim().startsWith(',')) continue;
      found.push({ token: name.toLowerCase(), line: index + 1 });
    }
  });

  return found;
}

describe('the chrome design tokens resolve', () => {
  /**
   * THE BUG THIS EXISTS FOR. `.sbk-rail` read `var(--sb-space-5)` and the scale in `globals.css`
   * is 1, 2, 3, 4, 6, 8, 12 — there is no 5. An undefined custom property is not "this one value
   * is missing": it makes the whole DECLARATION invalid at computed-value time, so
   * `padding: var(--sb-space-5) var(--sb-space-3)` resolved to no padding at all and the rail's
   * first nav row sat flush against its own hairline. No parse error, no console warning, and the
   * only symptom is a rail that looks slightly tight — i.e. exactly the class of defect a human
   * reviewer reads straight past.
   */
  it('defines every --sb* custom property that any sheet reads without a fallback', () => {
    const defined = definedTokens();
    const missing: string[] = [];

    for (const { file, source } of CODE) {
      for (const { token, line } of referencedTokens(source)) {
        if (!defined.has(token)) missing.push(`${file}:${line} reads ${token}`);
      }
    }

    expect(missing, `undefined custom properties silently void their whole declaration`).toEqual([]);
  });
});

describe('the private surfaces paint the canvas, not a box in the middle of it', () => {
  /**
   * THE SECOND BUG. `dashboard/layout.tsx` and `admin/layout.tsx` stamp `data-surface` on a DIV, and
   * the ground is painted from that selector. A div's box is the viewport rectangle and nothing
   * beyond it, so the two edges the UA reserves for scrollbar gutters — in `dir="rtl"` the physical
   * LEFT one and the bottom strip — kept `body`'s cream `--sb-bg` from `globals.css`. Invisible on
   * the signed-in dashboard, where the shell scrolls internally; plainly visible on the signed-out
   * sign-in card, where the document scrolls.
   *
   * `color-scheme: dark` had the same shape of problem: set on the div, it cannot restyle viewport
   * scrollbars, which follow `:root`.
   *
   * Asserted on the SELECTOR rather than by rendering, because there is no jsdom in this suite and
   * the property being checked — "an html background propagates to the canvas" — is a spec
   * guarantee, not something a snapshot would prove.
   */
  const cases = [
    { file: 'src/app/dashboard/dashboard.css', surface: 'app' },
    { file: 'src/app/admin/admin.css', surface: 'admin' },
  ] as const;

  for (const { file, surface } of cases) {
    const source = SHEETS.find((sheet) => sheet.file === file)?.source ?? '';

    it(`lets html carry the ${surface} ground so the scrollbar gutters are not cream`, () => {
      expect(source, file).toContain(`html:has([data-surface='${surface}'])`);
    });

    it(`lets html carry the ${surface} dark scheme so the gutters are not light`, () => {
      expect(source, file).toContain(`html:has([data-surface='${surface}'][data-theme='dark'])`);
    });
  }

  /**
   * The reason the fix is a `:has()` widening rather than moving the attribute up to `html`:
   * `theme-switch.tsx` resolves its target with `closest('[data-surface]')`, so the attribute has
   * to stay on an element the switch can find from inside the page. If that ever changes, the
   * selectors above stop matching and this pins the assumption they rest on.
   */
  it('keeps the theme switch writing to the element the :has() selectors look for', () => {
    const switchSource = readFileSync(
      path.join(repoRoot, 'src/app/_components/theme-switch.tsx'),
      'utf8',
    );
    expect(switchSource).toContain("closest('[data-surface]')");
  });
});

/**
 * PHASE 12.B — the catalogue's order control.
 *
 * Asserted against the SOURCE rather than by running a query, for the reason the file above states:
 * there is no database in the unit project. What is actually at risk here is not the SQL — Prisma
 * types that — but the four rules that make a URL-driven control behave: a closed set, a stable
 * tie-break, a canonical default, and every link carrying the state the others set.
 */
describe('the catalogue orders itself from the URL, and only from a closed set', () => {
  const data = readFileSync(path.join(repoRoot, 'src/app/site/_data/products.ts'), 'utf8');
  const page = readFileSync(path.join(repoRoot, 'src/app/site/products/page.tsx'), 'utf8');

  /**
   * A sort key taken from a query string and handed to `orderBy` is a visitor choosing which column
   * a stranger's shop is ordered by — and the next column added to `Product` is one they can order
   * by too. The set is closed and resolved in `_data`, and the page validates against it.
   */
  it('never forwards the raw ?sort= parameter to the query', () => {
    expect(data).toContain("export const PRODUCT_SORTS = ['featured', 'newest', 'price_asc', 'price_desc']");
    expect(page).toContain('isProductSort(requestedSort) ? requestedSort : ');
    expect(page).not.toMatch(/sort:\s*(requestedSort|firstParam\(params\.sort\))/);
  });

  /**
   * THE TIE-BREAK IS THE BUG THIS CATCHES. `orderBy: { priceAgorot: 'asc' }` alone leaves rows at
   * the same price in planner order, which is free to differ between two identical queries — so a
   * catalogue with thirty items at ₪50 can show one product on both page 1 and page 2 while never
   * showing another at all. Every order has to end on a unique column.
   */
  it('ends every order on a unique column so pagination cannot repeat or drop a row', () => {
    const block = data.slice(data.indexOf('const SORT_ORDER'), data.indexOf('export interface ProductQuery'));
    const orders = [...block.matchAll(/\[([^\]]*)\]/g)]
      .map((m) => m[1] ?? '')
      /*
        The declaration's own TYPE contains a bracket pair — `Record<ProductSort,
        Prisma.ProductOrderByWithRelationInput[]>` — and an empty one matches `[^\]]*` perfectly.
        That fifth "array" is what failed this assertion on its first run, and it is the second time
        in this file that a source scan matched the syntax it was describing rather than the code it
        meant. An `orderBy` array always contains at least one `{ … }`; a type's `[]` never does.
      */
      .filter((args) => args.includes('{'));

    expect(orders.length, 'expected one array per sort key').toBe(4);
    for (const order of orders) {
      expect(order.trimEnd().endsWith("{ id: 'asc' }"), order).toBe(true);
    }
  });

  /**
   * The canonical URL of the unfiltered, unsorted first page has to stay exactly `/products` — the
   * address the sitemap, the header nav and `generateMetadata` all already use. A `?sort=featured`
   * meaning "the default" would be a second URL for one page.
   */
  it('drops the default order from the URL, and marks the others noindex', () => {
    expect(page).toContain("if (sort !== 'featured') params.set('sort', sort)");
    expect(page).toContain('noindex: tag !== undefined || sorted');
  });

  /**
   * A control that resets itself when you use the control beside it reads as broken. Every link on
   * the page goes through `buildHref` carrying the live sort — including the two category chips,
   * which were hand-built strings and silently discarded it.
   */
  it('carries the active order through every link on the page', () => {
    expect(page).not.toMatch(/href=\{`\/products\?category=/);

    const hrefs = [...page.matchAll(/buildHref\(([^)]*)\)/g)]
      .map((m) => m[1] ?? '')
      // `[^)]` matches newlines, so the DECLARATION's parameter list matches too — and it would
      // fail the assertion below for containing no `activeSort`. A type annotation is the one
      // thing a call site never has.
      .filter((args) => !args.includes(':'));

    expect(hrefs.length, 'expected every link to be built by buildHref').toBeGreaterThan(4);

    // The sort chips pass a literal `option`; every other link passes the resolved `activeSort`.
    for (const args of hrefs) {
      expect(/activeSort|option/.test(args), `buildHref(${args}) drops the sort`).toBe(true);
    }
  });
});
