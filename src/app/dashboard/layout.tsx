import type { Metadata } from 'next';
import { cookies, headers } from 'next/headers';
import { absoluteUrl, storefrontHost } from '@/env';
import { TENANT_HEADERS } from '@/server/tenancy';
import { t } from '@/shared/i18n';
import {
  UI_ACCENT_COOKIE,
  UI_THEME_COOKIE,
  UI_THEME_DEFAULT,
  isUiAccentKey,
  isUiTheme,
  type UiAccentKey,
  type UiTheme,
} from '@/shared/ui-theme';
import { optionalMerchantContext, merchantCan, type MerchantContext } from './_lib/context';
import { DashboardNav, type NavItem } from './_components/nav';
import { ImpersonationBanner } from './_components/impersonation-banner';
import './dashboard.css';
// Phase 11 (Track 11.F): the shared chrome — shell, grouped rail, drawer, command palette —
// styled once against the `--sbx-*` bridge dashboard.css maps at its top.
import '../kit.css';

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

/** Same contract as the admin layout: SSR-stamped theme attributes, cookie-decided. */
async function uiTheme(): Promise<{
  theme: UiTheme;
  accent: UiAccentKey | null;
  railCollapsed: boolean;
}> {
  const jar = await cookies();
  const theme = jar.get(UI_THEME_COOKIE)?.value;
  const accent = jar.get(UI_ACCENT_COOKIE)?.value;
  return {
    theme: isUiTheme(theme) ? theme : UI_THEME_DEFAULT,
    accent: isUiAccentKey(accent) ? accent : null,
    // Phase 11: the collapsed-rail preference, SSR-stamped for the same no-flash reason the
    // theme is. Written by the kit's toggle (`sb-rail`), a UI cookie exactly like the theme's.
    railCollapsed: jar.get('sb-rail')?.value === '1',
  };
}

export default async function DashboardSurfaceLayout({ children }: { children: React.ReactNode }) {
  /**
   * THE LIVE PREVIEW RENDERS BARE (Phase 11, Track 11.D / Q37). The proxy stamps
   * `x-souq-preview: 1` on exactly the preview segment — the same one-path predicate that
   * relaxes `frame-ancestors` — and this layout then renders no rail, no `<main>`, no chrome:
   * the preview page IS a storefront document (its `StorefrontShell` carries the page's single
   * `main#main`), and dashboard chrome around a framed storefront would be chrome inside chrome.
   *
   * The phase plan sketched this as a `(shell)` route group; a header-keyed branch in the one
   * root layout is the same partition with the chrome staying where every route already is, and
   * it keeps the session guard exactly where it was — the preview route enforces its own
   * (`requireMerchantPage('appearance')`), as every route on this surface does. Recorded in
   * docs/DECISIONS.md.
   */
  const requestHeaders = await headers();
  if (requestHeaders.get(TENANT_HEADERS.preview) === '1') {
    return <div data-surface="app">{children}</div>;
  }

  const [ctx, { theme, accent, railCollapsed }] = await Promise.all([
    optionalMerchantContext(),
    uiTheme(),
  ]);

  if (!ctx) {
    return (
      <div data-surface="app" data-theme={theme} data-accent={accent ?? undefined}>
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
    <div data-surface="app" data-theme={theme} data-accent={accent ?? undefined}>
      {ctx.isImpersonated ? <ImpersonationBanner tenantName={tenant?.name ?? ''} /> : null}

      <div className="sbk-shell" data-collapsed={railCollapsed ? 'true' : undefined}>
        <DashboardNav
          items={items}
          userName={ctx.session.user.name}
          roleLabel={t('dashboard', ctx.role === 'owner' ? 'shell.roleOwner' : 'shell.roleStaff')}
          siteName={site?.name ?? tenant?.name ?? ''}
          storefrontUrl={tenant ? absoluteUrl(storefrontHost(tenant.slug)) : '/'}
          theme={theme}
          accent={accent}
          railCollapsed={railCollapsed}
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
  /**
   * `orders` is UNCONDITIONAL, beside products and media, and that is a decision rather than an
   * omission.
   *
   * It is not in `FEATURE_GATED` (src/server/auth/rbac.ts), so it is not gated on
   * `payment_gateway`. Gating it there would hide a merchant's OWN TRADING HISTORY the moment an
   * admin switched the gateway off — the wrong axis entirely. Checkout and the gateway settings
   * consult the feature; the ledger does not. A shop that never sold online opens the screen and
   * reads «ما في طلبات بعد», which is true, and staff reach it on every plan because
   * `STAFF_ALLOWED` has held `orders` since Phase 1 waiting for exactly this surface (Q13).
   */
  const items: NavItem[] = [
    { href: '/', key: 'home' },
    { href: '/products', key: 'products' },
    { href: '/orders', key: 'orders' },
    { href: '/media', key: 'media' },
  ];

  // Both axes, per entry. `checkMerchantAccess` answers "may this role?" and "does this plan
  // include it?" together, so a basic-plan owner loses the analytics link and a staff member
  // loses appearance, sections, settings and staff — by the same call the routes make.
  const [
    appearance,
    sections,
    settings,
    staff,
    analytics,
    notifications,
    coupons,
    delivery,
    tax,
    customers,
    insights,
    billing,
  ] = await Promise.all([
    merchantCan(ctx, 'appearance'),
    merchantCan(ctx, 'sections'),
    merchantCan(ctx, 'settings'),
    merchantCan(ctx, 'staff'),
    merchantCan(ctx, 'analytics'),
    // Phase 4. The same call the route makes, so a متجر merchant loses the link and the URL at
    // once rather than finding a screen the nav forgot to hide.
    merchantCan(ctx, 'notifications'),
    // Phase 8. Same shape: the nav, the page guard and the write actions all consult this once.
    merchantCan(ctx, 'coupons'),
    /**
     * Phase 9. Four more of exactly the same shape — one `merchantCan` per entry, asking both axes
     * at once (src/server/auth/rbac.ts). Tracks D, E and C each proposed asking the two halves by
     * hand here because no scope existed; the scopes exist now, so the nav asks what the routes ask.
     */
    merchantCan(ctx, 'delivery'),
    merchantCan(ctx, 'tax'),
    merchantCan(ctx, 'customers'),
    merchantCan(ctx, 'insights'),
    /**
     * Phase 11 (Track 11.H / Q35) — the seventeenth item, and the one key that track added.
     * `billing` has been a role-gated scope since Phase 1 (Q13: staff never sees billing or the
     * subscription at all); the same call the route's guard makes, so a staff session never
     * receives the entry and never reaches the URL.
     */
    merchantCan(ctx, 'billing'),
  ]);

  if (appearance) items.push({ href: '/appearance', key: 'appearance' });
  if (sections) items.push({ href: '/sections', key: 'sections' });
  /**
   * Phase 9. `/content` is the hub for banners, the trust row, hours, stats, the two strips and the
   * shop's three marks. Gated on `settings` — the same scope its own routes guard on — rather than on
   * a `content` scope of its own: that scope would carry no feature key, so it would resolve
   * identically for every role and only give the nav a second name for one rule.
   *
   * Deliberately NOT gated on the three Phase 9 content features either. The strips screen has no
   * feature key at all, so the hub always has something in it, and the hub hides the cards a plan
   * does not include.
   */
  if (settings) items.push({ href: '/content', key: 'content' });
  if (settings) items.push({ href: '/settings', key: 'settings' });
  if (notifications) items.push({ href: '/notifications', key: 'notifications' });
  if (analytics) items.push({ href: '/analytics', key: 'analytics' });
  if (insights) items.push({ href: '/insights', key: 'insights' });
  if (coupons) items.push({ href: '/coupons', key: 'coupons' });
  if (delivery) items.push({ href: '/delivery', key: 'delivery' });
  if (tax) items.push({ href: '/tax', key: 'tax' });
  // «الزبائن» sits with the other owner-only business screens rather than beside «الطلبات», which
  // staff also reach.
  if (customers) items.push({ href: '/customers', key: 'customers' });
  if (staff) items.push({ href: '/staff', key: 'staff' });
  if (billing) items.push({ href: '/billing', key: 'billing' });

  return items;
}
