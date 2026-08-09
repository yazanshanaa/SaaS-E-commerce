import type { Metadata } from 'next';

/**
 * The Super Admin surface root — everything under `admin.{DOMAIN}`.
 *
 * proxy.ts rewrites `admin.{DOMAIN}/x` into `/admin/x`; the prefix is internal and never
 * appears in the URL bar, so every `href` in this subtree is written as the public path
 * (`/accounts`, not `/admin/accounts`). See SURFACE_ROOT in src/server/tenancy.
 *
 * OWNED BY A1 (docs/PHASES.md calls this folder `src/app/(admin)`). B1 adds `lifecycle/` and
 * B3 adds `demos/` in Group B. Phase 1 ships only the shell and the two contracts every
 * surface honours:
 *   - `data-surface` — what the shared e2e suite asserts on, so it does not have to be
 *     rewritten every time a track changes its chrome,
 *   - exactly one `<main id="main">` inside, matching the skip link in the root layout.
 */
export const metadata: Metadata = {
  title: 'إدارة المنصة',
  // The platform owner's surface is never indexed, on any plan, in any environment.
  robots: { index: false, follow: false, nocache: true },
};

export default function AdminSurfaceLayout({ children }: { children: React.ReactNode }) {
  return <div data-surface="admin">{children}</div>;
}
