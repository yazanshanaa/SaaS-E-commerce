'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { t } from '@/shared/i18n';

/** Tabs need the current path, and only the client router knows it after a navigation. */
export function AccountTabs({ tenantId }: { tenantId: string }) {
  const base = `/accounts/${tenantId}`;
  const raw = usePathname() ?? base;
  const current = raw.replace(/^\/admin(?=\/|$)/, '') || '/';

  const tabs = [
    { href: base, key: 'overview' },
    { href: `${base}/content`, key: 'content' },
    { href: `${base}/permissions`, key: 'permissions' },
    { href: `${base}/subscription`, key: 'subscription' },
  ];

  return (
    <nav className="sba-tabs" aria-label={t('admin', 'account.tabs.overview')}>
      {tabs.map((tab) => (
        <Link
          key={tab.href}
          href={tab.href}
          className="sba-tab"
          aria-current={current === tab.href ? 'page' : undefined}
        >
          {t('admin', `account.tabs.${tab.key}`)}
        </Link>
      ))}
    </nav>
  );
}
