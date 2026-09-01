import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { optionalAdminContext } from '@/server/admin';
import {
  UI_ACCENT_COOKIE,
  UI_THEME_COOKIE,
  UI_THEME_DEFAULT,
  isUiAccentKey,
  isUiTheme,
  type UiAccentKey,
  type UiTheme,
} from '@/shared/ui-theme';
import { AdminNav } from './_components/nav';
import './admin.css';
// Phase 11 (Track 11.G): the shared chrome kit, consumed read-only — see src/app/kit.css.
import '../kit.css';

/**
 * The Super Admin surface root — everything under `admin.{DOMAIN}`.
 *
 * proxy.ts rewrites `admin.{DOMAIN}/x` into `/admin/x`; the prefix is internal and never
 * appears in the URL bar, so every `href` in this subtree is written as the public path
 * (`/accounts`, not `/admin/accounts`). See SURFACE_ROOT in src/server/tenancy.
 *
 * OWNED BY A1. B1 adds `lifecycle/` and B3 adds `demos/` in Group B — this layout wraps those
 * too, which is why the rail is data-driven rather than hardcoded per screen.
 *
 * Two contracts every surface honours and this file keeps: `data-surface`, which the shared
 * e2e suite asserts on, and EXACTLY ONE `<main id="main">`, which the root layout's skip link
 * targets. Both branches below render one main — the signed-out branch is the sign-in card,
 * rendered in place on `/` rather than behind a redirect, because the same shared suite asserts
 * that the admin root never moves off `/`.
 */
export const metadata: Metadata = {
  title: 'إدارة المنصة',
  // The platform owner's surface is never indexed, on any plan, in any environment.
  robots: { index: false, follow: false, nocache: true },
};

/**
 * The theme cookies are read HERE, not in the client, so the first paint is already dark when
 * the person chose dark — `data-theme` / `data-accent` ride the same `data-surface` element the
 * tokens are scoped to. See `src/shared/ui-theme.ts` for why this is a cookie and not a column.
 */
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
    // Phase 11: the collapsed-rail preference (kit cookie), SSR-stamped like the theme.
    railCollapsed: jar.get('sb-rail')?.value === '1',
  };
}

export default async function AdminSurfaceLayout({ children }: { children: React.ReactNode }) {
  const [ctx, { theme, accent, railCollapsed }] = await Promise.all([
    optionalAdminContext(),
    uiTheme(),
  ]);

  if (!ctx) {
    return (
      <div data-surface="admin" data-theme={theme} data-accent={accent ?? undefined}>
        <main id="main" className="sba-auth">
          {children}
        </main>
      </div>
    );
  }

  return (
    <div data-surface="admin" data-theme={theme} data-accent={accent ?? undefined}>
      <div className="sbk-shell" data-collapsed={railCollapsed ? 'true' : undefined}>
        <AdminNav
          userName={ctx.session.user.name}
          theme={theme}
          accent={accent}
          railCollapsed={railCollapsed}
        />
        <main id="main" className="sba-main">
          {children}
        </main>
      </div>
    </div>
  );
}
