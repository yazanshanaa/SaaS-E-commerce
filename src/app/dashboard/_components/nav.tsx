'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { t } from '@/shared/i18n';
import type { UiAccentKey, UiTheme } from '@/shared/ui-theme';
import { KitRail, type KitNavGroup, type KitPaletteSearch } from '../../_components/kit/rail';
import { ThemeSwitch } from '../../_components/theme-switch';

/**
 * The merchant rail (Phase 11, Track 11.F): sixteen flat links became الرئيسية plus five groups,
 * each item with a glyph, on the shared kit chrome — the drawer, the collapse and the command
 * palette all arrive from `KitRail`, which `admin/_components/nav.tsx` consumes identically.
 *
 * THE ITEM LIST IS STILL BUILT BY THE SERVER and passed in — `navItems(ctx)` in `layout.tsx`
 * remains the single gate, asking `merchantCan` per entry exactly as the routes do. This
 * component only ARRANGES what it was given: the grouping map below carries KEYS, and a key the
 * server withheld simply leaves its slot empty (a group left with no items never renders its
 * heading). Filtering here instead would ship a staff member an inventory of the screens that
 * are not theirs — the rule this file has carried since B2.
 *
 * The grouping is Q29's answer, verbatim from the phase plan: it adds no key and drops none —
 * the one addition of the whole track, `billing`, is 11.H's screen and arrives through the
 * server list like every other entry (owner-only, so a staff session never receives it).
 */

export interface NavItem {
  href: string;
  key: string;
}

/** key → group. Order inside each array is the render order. */
const GROUPS: Array<{ labelKey: string | null; keys: string[] }> = [
  { labelKey: null, keys: ['home'] },
  { labelKey: 'groupStore', keys: ['products', 'coupons', 'customers'] },
  { labelKey: 'groupOrders', keys: ['orders', 'delivery', 'tax'] },
  { labelKey: 'groupSite', keys: ['appearance', 'sections', 'content', 'media'] },
  { labelKey: 'groupMarketing', keys: ['notifications', 'analytics', 'insights'] },
  { labelKey: 'groupAccount', keys: ['settings', 'staff', 'billing'] },
];

/** The screens whose own list pages already take `?search=` — the palette's deep rows. */
const SEARCHABLE: Record<string, string> = {
  orders: '/orders?search=',
  customers: '/customers?search=',
};

export function DashboardNav({
  items,
  userName,
  roleLabel,
  siteName,
  storefrontUrl,
  theme,
  accent,
  railCollapsed,
}: {
  items: NavItem[];
  userName: string;
  roleLabel: string;
  siteName: string;
  storefrontUrl: string;
  theme: UiTheme;
  accent: UiAccentKey | null;
  railCollapsed: boolean;
}) {
  const router = useRouter();
  const [signingOut, setSigningOut] = useState(false);

  async function signOut() {
    setSigningOut(true);
    try {
      await fetch('/api/auth/sign-out', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
    } finally {
      // A full refresh, not a client navigation: the session that decided this whole subtree is
      // gone, and every cached server component below it was rendered for someone who is no
      // longer signed in.
      router.refresh();
      setSigningOut(false);
    }
  }

  const byKey = new Map(items.map((item) => [item.key, item]));
  const grouped = new Set<string>();

  const groups: KitNavGroup[] = GROUPS.map((group) => ({
    label: group.labelKey ? t('dashboard', `nav.${group.labelKey}`) : null,
    items: group.keys.flatMap((key) => {
      const item = byKey.get(key);
      if (!item) return [];
      grouped.add(key);
      return [{ href: item.href, label: t('dashboard', `nav.${item.key}`), icon: item.key }];
    }),
  }));

  // A key the map does not know yet (a future phase's screen) still renders, ungrouped at the
  // end, rather than silently vanishing from the nav on the day it ships.
  const leftovers = items.filter((item) => !grouped.has(item.key));
  if (leftovers.length > 0) {
    groups.push({
      label: null,
      items: leftovers.map((item) => ({
        href: item.href,
        label: t('dashboard', `nav.${item.key}`),
        icon: item.key,
      })),
    });
  }

  const paletteSearches: KitPaletteSearch[] = items.flatMap((item) => {
    const base = SEARCHABLE[item.key];
    return base ? [{ label: t('dashboard', `nav.searchIn.${item.key}`), hrefBase: base }] : [];
  });

  return (
    <KitRail
      pathPrefix="/dashboard"
      collapsedInitial={railCollapsed}
      collapseCookie="sb-rail"
      groups={groups}
      paletteSearches={paletteSearches}
      labels={{
        navLabel: t('dashboard', 'nav.sectionLabel'),
        openMenu: t('dashboard', 'nav.openMenu'),
        closeMenu: t('dashboard', 'nav.closeMenu'),
        collapse: t('dashboard', 'nav.collapse'),
        expand: t('dashboard', 'nav.expand'),
        palette: t('dashboard', 'nav.palette'),
        paletteInput: t('dashboard', 'nav.paletteInput'),
        paletteEmpty: t('dashboard', 'nav.paletteEmpty'),
      }}
      brand={
        <Link href="/">
          {siteName}
          <small>{t('dashboard', 'title')}</small>
        </Link>
      }
      foot={
        <>
          <ThemeSwitch initialTheme={theme} initialAccent={accent} />
          <a className="sbd-btn sbd-btn--sm" href={storefrontUrl} rel="noreferrer noopener">
            {t('dashboard', 'shell.visitSite')}
          </a>
          <span>
            {t('dashboard', 'shell.signedInAs', { name: userName })} · {roleLabel}
          </span>
          <button
            type="button"
            className="sbd-btn sbd-btn--sm"
            onClick={signOut}
            disabled={signingOut}
          >
            {t('dashboard', 'shell.signOut')}
          </button>
        </>
      }
    />
  );
}
