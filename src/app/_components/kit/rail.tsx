'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CloseIcon, CollapseIcon, MenuIcon, NavIcon, SearchIcon } from './icons';

/**
 * The shared navigation chrome for the two private surfaces (Phase 11, Tracks 11.F / 11.G).
 *
 * One component, consumed by both rails, styled once in `src/app/kit.css` against the `--sbx-*`
 * bridge — which is what "extracted, not duplicated again" means mechanically: a change here
 * reaches merchant and admin together, and neither surface may fork it (invariant extension 7).
 *
 * WHAT IT REPLACES: two flat link lists (16 merchant / 10 admin) that below 60rem became a
 * wrapping band of links ABOVE the content — no drawer, no toggle, no `aria-expanded`. Now:
 *
 *   - GROUPS. The items arrive from the server exactly as before (the server-built list is the
 *     single gate — filtering client-side would ship a staff member an inventory of screens that
 *     are not theirs); this component only ARRANGES what it was given, and a group none of whose
 *     items survived the server's gate never renders its heading.
 *   - DRAWER below 48rem: off-canvas behind a labelled toggle with `aria-expanded` /
 *     `aria-controls`, focus moved in on open, trapped while open, `Esc` to close, the toggle
 *     refocused on close.
 *   - COLLAPSIBLE rail above 48rem: icons-only, the label kept in the tree for screen readers,
 *     the state in a cookie so the server can render the collapsed shell without a flash.
 *   - COMMAND PALETTE (`⌘K` / `Ctrl+K`): navigation entries first, then deep-search rows that
 *     land on the existing screens' own search — deliberately NOT a client-side index of the
 *     catalogue, and deliberately no new API route (this track's gate forbids route changes).
 */

export interface KitNavItem {
  href: string;
  label: string;
  /** A key into KIT_ICONS. */
  icon: string;
}

export interface KitNavGroup {
  /** null = ungrouped (the home entry). */
  label: string | null;
  items: KitNavItem[];
}

export interface KitPaletteSearch {
  label: string;
  /** The existing screen the query lands on, e.g. `/products?q=`. */
  hrefBase: string;
}

export interface KitRailLabels {
  navLabel: string;
  openMenu: string;
  closeMenu: string;
  collapse: string;
  expand: string;
  palette: string;
  paletteInput: string;
  paletteEmpty: string;
}

export interface KitRailProps {
  brand: React.ReactNode;
  groups: KitNavGroup[];
  foot: React.ReactNode;
  /** `/dashboard` or `/admin` — stripped off `usePathname()` before comparing. */
  pathPrefix: string;
  labels: KitRailLabels;
  collapsedInitial: boolean;
  /** Cookie name for the collapsed state — read by the layout for a flash-free first paint. */
  collapseCookie: string;
  paletteSearches: KitPaletteSearch[];
}

function publicPath(pathname: string, prefix: string): string {
  const stripped = pathname.replace(new RegExp(`^${prefix}(?=/|$)`), '');
  return stripped === '' ? '/' : stripped;
}

function isActive(current: string, href: string): boolean {
  if (href === '/') return current === '/';
  return current === href || current.startsWith(`${href}/`);
}

/** Keep focus inside `container` while a modal layer is open. */
function trapTab(event: KeyboardEvent, container: HTMLElement) {
  if (event.key !== 'Tab') return;
  const focusables = container.querySelectorAll<HTMLElement>(
    'a[href], button:not([disabled]), input, [tabindex]:not([tabindex="-1"])',
  );
  if (focusables.length === 0) return;
  const first = focusables[0]!;
  const last = focusables[focusables.length - 1]!;
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

export function KitRail({
  brand,
  groups,
  foot,
  pathPrefix,
  labels,
  collapsedInitial,
  collapseCookie,
  paletteSearches,
}: KitRailProps) {
  const pathname = publicPath(usePathname() ?? '/', pathPrefix);
  const router = useRouter();

  // --- drawer (below 48rem) -------------------------------------------------
  const [drawerOpen, setDrawerOpen] = useState(false);
  const railRef = useRef<HTMLElement | null>(null);
  const toggleRef = useRef<HTMLButtonElement | null>(null);

  /*
   * NOT `useCallback`. This project compiles with the React Compiler, which memoises for us — and
   * the hand-written `[]` was actively worse than nothing: the compiler inferred `setDrawerOpen`
   * as a dependency, could not reconcile that with the empty array, and responded by SKIPPING
   * optimisation of the whole component (`react-hooks/preserve-manual-memoization`). A manual
   * memo that disagrees with the compiler costs the memoisation it was written to guarantee.
   */
  const closeDrawer = () => {
    setDrawerOpen(false);
    toggleRef.current?.focus();
  };

  useEffect(() => {
    if (!drawerOpen) return;
    const rail = railRef.current;
    rail?.querySelector<HTMLElement>('a, button')?.focus();

    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeDrawer();
      else if (rail) trapTab(event, rail);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [drawerOpen, closeDrawer]);

  /*
   * The drawer closes on navigation — a drawer left open over a new page is a modal nobody asked
   * for.
   *
   * ADJUSTED DURING RENDER, not in an effect. As `useEffect(() => setDrawerOpen(false), [pathname])`
   * this rendered the new page with the drawer still open, then immediately re-rendered it closed:
   * a cascading render, and a visible frame of the old drawer over the new page on a slow phone.
   * `react-hooks/set-state-in-effect` flags exactly this.
   *
   * Comparing the previous value during render is React's documented pattern for "reset state when
   * a prop changes" — the setState here is not a loop: React restarts the render immediately with
   * the new state, before touching the DOM, and never commits the intermediate one.
   */
  const [drawerPath, setDrawerPath] = useState(pathname);
  if (drawerPath !== pathname) {
    setDrawerPath(pathname);
    setDrawerOpen(false);
  }

  // --- collapse (above 48rem) ----------------------------------------------
  const [collapsed, setCollapsed] = useState(collapsedInitial);

  const toggleCollapsed = useCallback(() => {
    setCollapsed((current) => {
      const next = !current;
      // A UI preference, exactly like the theme cookie one panel over: host-only, a year.
      document.cookie = `${collapseCookie}=${next ? '1' : '0'}; path=/; max-age=31536000; samesite=lax`;
      return next;
    });
  }, [collapseCookie]);

  // --- the palette ----------------------------------------------------------
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [query, setQuery] = useState('');
  const paletteRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPaletteOpen((open) => !open);
        setQuery('');
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (!paletteOpen) return;
    const container = paletteRef.current;
    container?.querySelector<HTMLInputElement>('input')?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setPaletteOpen(false);
      else if (container) trapTab(event, container);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [paletteOpen]);

  const allItems = useMemo(() => groups.flatMap((group) => group.items), [groups]);
  const matches = useMemo(() => {
    const needle = query.trim();
    if (needle === '') return allItems;
    return allItems.filter((item) => item.label.includes(needle));
  }, [allItems, query]);

  // Plain function, for the reason given on `closeDrawer` — the `[router]` array disagreed with
  // the compiler's inferred `setPaletteOpen` / `setQuery` and cost the component its optimisation.
  const go = (href: string) => {
    setPaletteOpen(false);
    setQuery('');
    router.push(href);
  };

  const navBody = (
    <>
      {groups.map((group, index) =>
        group.items.length === 0 ? null : (
          <div className="sbk-group" key={group.label ?? `top-${index}`}>
            {group.label ? <span className="sbk-group-label">{group.label}</span> : null}
            {group.items.map((item) => (
              <Link
                key={item.href}
                className="sbk-link"
                href={item.href}
                aria-current={isActive(pathname, item.href) ? 'page' : undefined}
                title={collapsed ? item.label : undefined}
              >
                <NavIcon name={item.icon} className="sbk-link__icon" />
                <span className="sbk-link__label">{item.label}</span>
              </Link>
            ))}
          </div>
        ),
      )}
    </>
  );

  return (
    <>
      {/* The mobile top bar: menu, brand, palette. Hidden by the kit above 48rem. */}
      <div className="sbk-topbar">
        <button
          ref={toggleRef}
          type="button"
          className="sbk-icon-btn"
          aria-expanded={drawerOpen}
          aria-controls="sbk-rail"
          onClick={() => setDrawerOpen((open) => !open)}
        >
          {drawerOpen ? <CloseIcon /> : <MenuIcon />}
          <span className="sbk-vh">{drawerOpen ? labels.closeMenu : labels.openMenu}</span>
        </button>
        <div className="sbk-topbar__brand">{brand}</div>
        <button
          type="button"
          className="sbk-icon-btn"
          onClick={() => setPaletteOpen(true)}
        >
          <SearchIcon />
          <span className="sbk-vh">{labels.palette}</span>
        </button>
      </div>

      {drawerOpen ? (
        <div className="sbk-backdrop" onClick={closeDrawer} aria-hidden="true" />
      ) : null}

      <nav
        id="sbk-rail"
        ref={railRef}
        className="sbk-rail"
        data-open={drawerOpen ? 'true' : undefined}
        data-collapsed={collapsed ? 'true' : undefined}
        aria-label={labels.navLabel}
      >
        <div className="sbk-rail__brand">{brand}</div>

        <button
          type="button"
          className="sbk-icon-btn sbk-palette-btn"
          onClick={() => setPaletteOpen(true)}
        >
          <SearchIcon />
          <span className="sbk-link__label">{labels.palette}</span>
          <kbd className="sbk-kbd" aria-hidden="true">
            Ctrl K
          </kbd>
        </button>

        <div className="sbk-nav">{navBody}</div>

        <div className="sbk-rail__foot">{foot}</div>

        <button
          type="button"
          className="sbk-icon-btn sbk-collapse-btn"
          aria-pressed={collapsed}
          onClick={toggleCollapsed}
          title={collapsed ? labels.expand : labels.collapse}
        >
          <CollapseIcon className="sbk-collapse-btn__icon" />
          <span className="sbk-vh">{collapsed ? labels.expand : labels.collapse}</span>
        </button>
      </nav>

      {paletteOpen ? (
        <div className="sbk-palette-layer">
          <div
            className="sbk-palette-backdrop"
            onClick={() => setPaletteOpen(false)}
            aria-hidden="true"
          />
          <div
            ref={paletteRef}
            className="sbk-palette"
            role="dialog"
            aria-modal="true"
            aria-label={labels.palette}
          >
            <input
              className="sbk-palette__input"
              type="text"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={labels.paletteInput}
              spellCheck={false}
            />
            <ul className="sbk-palette__list">
              {matches.map((item) => (
                <li key={item.href}>
                  <button type="button" className="sbk-palette__item" onClick={() => go(item.href)}>
                    <NavIcon name={item.icon} className="sbk-link__icon" />
                    {item.label}
                  </button>
                </li>
              ))}
              {query.trim() !== ''
                ? paletteSearches.map((search) => (
                    <li key={search.hrefBase}>
                      <button
                        type="button"
                        className="sbk-palette__item sbk-palette__item--search"
                        onClick={() => go(`${search.hrefBase}${encodeURIComponent(query.trim())}`)}
                      >
                        <SearchIcon className="sbk-link__icon" />
                        {search.label}
                        <span className="sbk-palette__query">{query.trim()}</span>
                      </button>
                    </li>
                  ))
                : null}
              {matches.length === 0 && query.trim() === '' ? (
                <li className="sbk-palette__empty">{labels.paletteEmpty}</li>
              ) : null}
              {matches.length === 0 && query.trim() !== '' && paletteSearches.length === 0 ? (
                <li className="sbk-palette__empty">{labels.paletteEmpty}</li>
              ) : null}
            </ul>
          </div>
        </div>
      ) : null}
    </>
  );
}
