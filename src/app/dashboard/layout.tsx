import type { Metadata } from 'next';

/**
 * The merchant dashboard surface root — everything under `app.{DOMAIN}`.
 *
 * OWNED BY B2 (docs/PHASES.md calls this folder `src/app/(dashboard)`). Note what does NOT
 * live here: `/demo-request` and `/export/{token}` keep their public paths on app.* because
 * both are links handed to someone outside the platform (see UNPREFIXED_PATHS in
 * src/server/tenancy) — they are B3's and Phase 1's respectively, not B2's.
 */
export const metadata: Metadata = {
  title: 'لوحة تحكم المتجر',
  robots: { index: false, follow: false, nocache: true },
};

export default function DashboardSurfaceLayout({ children }: { children: React.ReactNode }) {
  return <div data-surface="app">{children}</div>;
}
