import type { Metadata } from 'next';
import { optionalAdminContext } from '@/server/admin';
import { AdminNav } from './_components/nav';
import './admin.css';

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

export default async function AdminSurfaceLayout({ children }: { children: React.ReactNode }) {
  const ctx = await optionalAdminContext();

  if (!ctx) {
    return (
      <div data-surface="admin">
        <main id="main" className="sba-auth">
          {children}
        </main>
      </div>
    );
  }

  return (
    <div data-surface="admin">
      <div className="sba-shell">
        <AdminNav userName={ctx.session.user.name} />
        <main id="main" className="sba-main">
          {children}
        </main>
      </div>
    </div>
  );
}
