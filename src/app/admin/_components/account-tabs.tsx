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
    // Phase 9. Assigning platform carriers to THIS shop. After `permissions` because it is the same
    // kind of decision — what this tenant is given — and before `subscription`, which is money.
    { href: `${base}/carriers`, key: 'carriers' },
    { href: `${base}/subscription`, key: 'subscription' },
    // Phase 10 (Q24, Q26). LAST, after money, because it is the tab an operator visits least and
    // the one whose buttons do the most: a restore rewrites the shop, and an export hands its whole
    // catalogue to somebody. Distance from the tabs used daily is deliberate.
    { href: `${base}/backups`, key: 'backups' },
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
