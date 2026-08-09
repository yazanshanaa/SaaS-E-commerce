import { headers } from 'next/headers';
import { readRequestTenant } from '@/server/tenancy';
import { t } from '@/shared/i18n';

import '@/templates/storefront.css';
import '@/templates/diwan/diwan.css';
import '@/templates/neon-souq/neon-souq.css';
import '@/templates/warsheh/warsheh.css';

/**
 * The public storefront surface root — `{slug}.{DOMAIN}` and every verified custom domain.
 *
 * OWNED BY A2 (docs/PHASES.md calls this folder `src/app/(storefront)`).
 *
 * No `metadata` export here on purpose: unlike the two private surfaces, a storefront's title,
 * description, OG tags and robots directives are per tenant, so every page generates its own
 * through `_data/metadata.ts`. A static default here would be inherited by any page that had not
 * overridden it — which is the shape "one merchant's site described as another's" takes.
 *
 * WHY ALL FOUR STYLESHEETS. Next bundles the CSS a route imports into one file, so this is a
 * single cached request, not four; each template's rules are namespaced under its own
 * `[data-template]` selector and the `@font-face` declarations cost nothing until text actually
 * matches a family. The alternative — inlining the active template's CSS into every document —
 * would repeat the same bytes on every page view and could never be cached.
 *
 * THE SUSPENSION GUARD LIVES HERE. A suspended storefront closes immediately (Q2, no grace
 * period), and putting the check in the layout means every route in this subtree is covered by
 * construction rather than by each page remembering.
 */
export default async function StorefrontSurfaceLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const tenant = readRequestTenant(await headers());

  if (tenant.isSuspended) {
    return (
      <div data-surface="storefront">
        <main id="main" className="sb-page">
          <div className="sb-card">
            <h1 className="sb-title">{t('common', 'suspended.title')}</h1>
            <p className="sb-muted">{t('common', 'suspended.body')}</p>
          </div>
        </main>
      </div>
    );
  }

  return <div data-surface="storefront">{children}</div>;
}
