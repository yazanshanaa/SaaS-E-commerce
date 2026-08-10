'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useState } from 'react';
import { t } from '@/shared/i18n';

/**
 * The rail.
 *
 * Two things here are consequences of how this platform routes:
 *
 *   1. Every `href` is the PUBLIC path (`/accounts`), never the internal rewrite target
 *      (`/admin/accounts`). proxy.ts owns the prefix and the URL bar never shows it.
 *   2. `usePathname()` can hand back either form depending on whether the value came from the
 *      server render (which sees the rewritten path) or the client router (which sees the
 *      address bar), so it is normalised before anything is compared. Getting this wrong does
 *      not break navigation — it silently highlights nothing, which is the kind of bug that
 *      survives review because everything still works.
 */

const ITEMS = [
  { href: '/', key: 'overview' },
  { href: '/accounts', key: 'accounts' },
  { href: '/change-requests', key: 'changeRequests' },
  { href: '/plans', key: 'plans' },
  { href: '/audit', key: 'audit' },
] as const;

function publicPath(pathname: string): string {
  const stripped = pathname.replace(/^\/admin(?=\/|$)/, '');
  return stripped === '' ? '/' : stripped;
}

function isActive(current: string, href: string): boolean {
  if (href === '/') return current === '/';
  return current === href || current.startsWith(`${href}/`);
}

export function AdminNav({ userName }: { userName: string }) {
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
      // gone, and every cached server component below it was rendered for a person who is no
      // longer signed in.
      router.refresh();
      setSigningOut(false);
    }
  }

  return (
    <nav className="sba-rail" aria-label={t('admin', 'shell.sectionLabel')}>
      <Link className="sba-brand" href="/">
        {t('admin', 'title')}
      </Link>

      <div className="sba-nav">
        {ITEMS.map((item) => (
          <Link
            key={item.href}
            className="sba-nav-link"
            href={item.href}
            aria-current={isActive(pathname, item.href) ? 'page' : undefined}
          >
            {t('admin', `nav.${item.key}`)}
          </Link>
        ))}
      </div>

      <div className="sba-rail-foot">
        <span>{t('admin', 'shell.signedInAs', { name: userName })}</span>
        <button
          type="button"
          className="sba-btn sba-btn--sm"
          onClick={signOut}
          disabled={signingOut}
        >
          {t('admin', 'shell.signOut')}
        </button>
      </div>
    </nav>
  );
}
