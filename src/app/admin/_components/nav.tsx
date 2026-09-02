'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { t } from '@/shared/i18n';
import type { UiAccentKey, UiTheme } from '@/shared/ui-theme';
import { KitRail, type KitNavGroup } from '../../_components/kit/rail';
import { ThemeSwitch } from '../../_components/theme-switch';

/**
 * The admin rail (Phase 11, Track 11.G): ten flat links became الرئيسية plus three groups, on
 * the SAME kit chrome the merchant rail consumes (`src/app/_components/kit/rail.tsx`) — same
 * drawer, same collapse, same palette, same breakpoints; the ledger keeps its own density and
 * 4px radius through the `--sbx-*` bridge values `admin.css` maps.
 *
 * The list stays hardcoded exactly as A1 built it — every admin session sees every screen, so
 * there is no per-item gate to consult — and the grouping is Q29's, verbatim from the plan:
 * الحسابات is the per-tenant work, العروض is the platform's own catalogue, الرقابة is "show me
 * what happened and prove it". Nothing added, nothing dropped.
 */

const GROUPS: Array<{ labelKey: string | null; items: Array<{ href: string; key: string }> }> = [
  { labelKey: null, items: [{ href: '/', key: 'overview' }] },
  {
    labelKey: 'groupAccounts',
    items: [
      { href: '/accounts', key: 'accounts' },
      { href: '/lifecycle', key: 'lifecycle' },
      { href: '/change-requests', key: 'changeRequests' },
    ],
  },
  {
    labelKey: 'groupOffering',
    items: [
      { href: '/demos', key: 'demos' },
      { href: '/plans', key: 'plans' },
      { href: '/carriers', key: 'carriers' },
    ],
  },
  {
    labelKey: 'groupOversight',
    items: [
      { href: '/audit', key: 'audit' },
      { href: '/privacy', key: 'privacy' },
      { href: '/backups', key: 'backups' },
    ],
  },
];

export function AdminNav({
  userName,
  theme,
  accent,
  railCollapsed,
}: {
  userName: string;
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
      // gone, and every cached server component below it was rendered for a person who is no
      // longer signed in.
      router.refresh();
      setSigningOut(false);
    }
  }

  const groups: KitNavGroup[] = GROUPS.map((group) => ({
    label: group.labelKey ? t('admin', `nav.${group.labelKey}`) : null,
    items: group.items.map((item) => ({
      href: item.href,
      label: t('admin', `nav.${item.key}`),
      icon: item.key,
    })),
  }));

  return (
    <KitRail
      pathPrefix="/admin"
      collapsedInitial={railCollapsed}
      collapseCookie="sb-rail"
      groups={groups}
      // The accounts screen's own search (`/accounts?q=`) — the one admin list an operator
      // reaches for by name.
      paletteSearches={[{ label: t('admin', 'nav.searchAccounts'), hrefBase: '/accounts?q=' }]}
      labels={{
        navLabel: t('admin', 'shell.sectionLabel'),
        openMenu: t('admin', 'shell.openMenu'),
        closeMenu: t('admin', 'shell.closeMenu'),
        collapse: t('admin', 'shell.collapse'),
        expand: t('admin', 'shell.expand'),
        palette: t('admin', 'shell.palette'),
        paletteInput: t('admin', 'shell.paletteInput'),
        paletteEmpty: t('admin', 'shell.paletteEmpty'),
      }}
      brand={<Link href="/">{t('admin', 'title')}</Link>}
      foot={
        <>
          <ThemeSwitch initialTheme={theme} initialAccent={accent} />
          <span>{t('admin', 'shell.signedInAs', { name: userName })}</span>
          <button
            type="button"
            className="sba-btn sba-btn--sm"
            onClick={signOut}
            disabled={signingOut}
          >
            {t('admin', 'shell.signOut')}
          </button>
        </>
      }
    />
  );
}
