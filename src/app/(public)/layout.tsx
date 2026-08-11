import './public.css';

/**
 * The PUBLIC surface — pages served to someone who has no account and never will have one here.
 *
 * Today that is exactly one page: `/demo-request`. The group exists rather than the page standing
 * alone because a public page needs chrome none of the other three surfaces can lend it. The admin
 * panel and the merchant dashboard both assume a signed-in person and both scope their stylesheets
 * to their own `data-surface`; the storefront belongs to a merchant and carries their branding.
 *
 * `(public)` is a route GROUP, so it is erased from the URL and this layout adds no path segment —
 * `demo-request/page.tsx` serves `/demo-request`, which is what `UNPREFIXED_PATHS` and
 * `APP_PUBLIC_PREFIXES` were already written for.
 *
 * Two contracts every surface honours and this file keeps: `data-surface`, which the shared e2e
 * suite asserts on, and EXACTLY ONE `<main id="main">`, the target of the skip link in the root
 * layout. `public` rather than `app` is deliberate: `dashboard.css` is scoped to
 * `[data-surface='app']` and is a global stylesheet once bundled, so reusing that value would pull
 * the dashboard's chrome onto a page that has no dashboard.
 *
 * `lang` and `dir` are NOT set here. The root layout sets `lang="ar" dir="rtl"` on `<html>` and RTL
 * is the starting point, not a mirror applied afterwards (CLAUDE.md).
 */
export default function PublicSurfaceLayout({ children }: { children: React.ReactNode }) {
  return (
    <div data-surface="public">
      <main id="main" className="sbp-main">
        {children}
      </main>
    </div>
  );
}
