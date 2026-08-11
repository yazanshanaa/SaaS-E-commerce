'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useState } from 'react';
import { t } from '@/shared/i18n';

/**
 * The rail.
 *
 * Two consequences of how this platform routes, identical to A1's and for the same reasons:
 *
 *   1. every `href` is the PUBLIC path (`/products`), never the internal rewrite target
 *      (`/dashboard/products`). proxy.ts owns the prefix and the URL bar never shows it;
 *   2. `usePathname()` returns either form depending on whether the value came from the server
 *      render (which sees the rewritten path) or the client router (which sees the address
 *      bar), so it is normalised before anything is compared. Getting this wrong does not break
 *      navigation — it silently highlights nothing, which is the kind of bug that survives
 *      review because everything still works.
 *
 * The item list is built by the SERVER and passed in. Filtering it here would mean shipping the
 * full list to a browser and hiding parts of it, which tells a staff member exactly which
 * screens exist and are not theirs — and would be a nav that disagrees with what the routes
 * actually allow.
 */

export interface NavItem {
  href: string;
  key: string;
}

function publicPath(pathname: string): string {
  const stripped = pathname.replace(/^\/dashboard(?=\/|$)/, '');
  return stripped === '' ? '/' : stripped;
}

function isActive(current: string, href: string): boolean {
  if (href === '/') return current === '/';
  return current === href || current.startsWith(`${href}/`);
}

export function DashboardNav({
  items,
  userName,
  roleLabel,
  siteName,
  storefrontUrl,
}: {
  items: NavItem[];
  userName: string;
  roleLabel: string;
  siteName: string;
  storefrontUrl: string;
}) {
  const pathname = publicPath(usePathname() ?? '/');
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

  return (
    <nav className="sbd-rail" aria-label={t('dashboard', 'nav.sectionLabel')}>
      <Link className="sbd-brand" href="/">
        {siteName}
        <small>{t('dashboard', 'title')}</small>
      </Link>

      <div className="sbd-nav">
        {items.map((item) => (
          <Link
            key={item.href}
            className="sbd-nav-link"
            href={item.href}
            aria-current={isActive(pathname, item.href) ? 'page' : undefined}
          >
            {t('dashboard', `nav.${item.key}`)}
          </Link>
        ))}
      </div>

      <div className="sbd-rail-foot">
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
      </div>
    </nav>
  );
}
