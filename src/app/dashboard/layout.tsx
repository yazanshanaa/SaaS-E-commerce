import type { Metadata } from 'next';
import { absoluteUrl, storefrontHost } from '@/env';
import { t } from '@/shared/i18n';
import { optionalMerchantContext, merchantCan, type MerchantContext } from './_lib/context';
import { DashboardNav, type NavItem } from './_components/nav';
import { ImpersonationBanner } from './_components/impersonation-banner';
import './dashboard.css';

/**
 * The merchant dashboard surface root — everything under `app.{DOMAIN}`.
 *
 * proxy.ts rewrites `app.{DOMAIN}/x` into `/dashboard/x`; the prefix is internal and never
 * appears in the URL bar, so every `href` in this subtree is written as the public path
 * (`/products`, not `/dashboard/products`). See SURFACE_ROOT in `src/server/tenancy`.
 *
 * Note what does NOT live here: `/demo-request` and `/export/{token}` keep their public paths on
 * app.* because both are links handed to someone outside the platform (UNPREFIXED_PATHS) — they
 * are B3's and Phase 1's respectively.
 *
 * Two contracts every surface honours and this file keeps: `data-surface`, which the shared e2e
 * suite asserts on, and EXACTLY ONE `<main id="main">`, which the root layout's skip link
 * targets. Both branches below render exactly one.
 *
 * The signed-out branch renders `children` and nothing else — the sign-in card belongs to `/`,
 * and `/forgot-password` and `/reset-password` render their own. A layout cannot see the
 * pathname, so putting the sign-in form here would have replaced the page a merchant just
 * followed a reset link to.
 *
 * THE NAV IS BUILT ON THE SERVER, from both access axes. Rendering the full list and hiding
 * items in the browser would ship a staff member an inventory of the screens that are not
 * theirs — and would eventually disagree with the routes, which check for themselves.
 */
export const metadata: Metadata = {
  title: 'لوحة تحكم المتجر',
  robots: { index: false, follow: false, nocache: true },
};

export default async function DashboardSurfaceLayout({ children }: { children: React.ReactNode }) {
  const ctx = await optionalMerchantContext();

  if (!ctx) {
    return (
      <div data-surface="app">
        <main id="main" className="sbd-auth">
          {children}
        </main>
      </div>
    );
  }

  const [site, tenant, items] = await Promise.all([
    ctx.db.site.findUnique({ where: { tenantId: ctx.tenantId }, select: { name: true } }),
    ctx.db.tenant.findUnique({
      where: { id: ctx.tenantId },
      select: { name: true, slug: true, state: true },
    }),
    navItems(ctx),
  ]);

  return (
    <div data-surface="app">
      {ctx.isImpersonated ? <ImpersonationBanner tenantName={tenant?.name ?? ''} /> : null}

      <div className="sbd-shell">
        <DashboardNav
          items={items}
          userName={ctx.session.user.name}
          roleLabel={t('dashboard', ctx.role === 'owner' ? 'shell.roleOwner' : 'shell.roleStaff')}
          siteName={site?.name ?? tenant?.name ?? ''}
          storefrontUrl={tenant ? absoluteUrl(storefrontHost(tenant.slug)) : '/'}
        />

        <main id="main" className="sbd-main">
          <div className="sbd-wrap">
            {/*
              A suspended account keeps its dashboard. The storefront closed the moment the
              period ended (there is no grace period, Q2) and the data is retained for the
              retention window — so the person most likely to open this page is a merchant
              deciding whether to pay, and locking them out of their own catalogue would be
              both unkind and bad business.
            */}
            {tenant?.state === 'suspended' ? (
              <div className="sbd-notice sbd-notice--error" role="status">
                {t('dashboard', 'shell.suspendedNotice')}
              </div>
            ) : null}
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}

async function navItems(ctx: MerchantContext): Promise<NavItem[]> {
  const items: NavItem[] = [
    { href: '/', key: 'home' },
    { href: '/products', key: 'products' },
    { href: '/media', key: 'media' },
  ];

  // Both axes, per entry. `checkMerchantAccess` answers "may this role?" and "does this plan
  // include it?" together, so a basic-plan owner loses the analytics link and a staff member
  // loses appearance, sections, settings and staff — by the same call the routes make.
  const [appearance, sections, settings, staff, analytics, notifications] = await Promise.all([
    merchantCan(ctx, 'appearance'),
    merchantCan(ctx, 'sections'),
    merchantCan(ctx, 'settings'),
    merchantCan(ctx, 'staff'),
    merchantCan(ctx, 'analytics'),
    // Phase 4. The same call the route makes, so a متجر merchant loses the link and the URL at
    // once rather than finding a screen the nav forgot to hide.
    merchantCan(ctx, 'notifications'),
  ]);

  if (appearance) items.push({ href: '/appearance', key: 'appearance' });
  if (sections) items.push({ href: '/sections', key: 'sections' });
  if (settings) items.push({ href: '/settings', key: 'settings' });
  if (notifications) items.push({ href: '/notifications', key: 'notifications' });
  if (analytics) items.push({ href: '/analytics', key: 'analytics' });
  if (staff) items.push({ href: '/staff', key: 'staff' });

  return items;
}
