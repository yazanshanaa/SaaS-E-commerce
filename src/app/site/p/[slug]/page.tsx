import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { notFound } from 'next/navigation';
import { getEnv } from '@/env';
import { PUBLIC_ACTOR, tenantDb } from '@/server/db';
import { type SectionType } from '@/shared/site-contract';
import { t } from '@/shared/i18n';
import { beaconDecision } from '@/server/analytics';
import {
  analyticsDecision,
  isLegalSlug,
  isSectionType,
  normaliseSectionConfig,
  SectionList,
  StorefrontShell,
} from '@/templates';
import { CONSENT_COOKIE, readConsentCookie } from '../../_data/consent';
import { loadStorefrontContext } from '../../_data/context';
import { storefrontMetadata } from '../../_data/metadata';
import { requireStorefront } from '../../_data/surface';

/**
 * Content pages — `/p/{slug}`.
 *
 * This is the route the PERMANENT LEGAL FOOTER points at, and it is the placeholder
 * docs/PHASES.md promises Phase 6: `src/server/legal` generates the five (or six) Arabic legal
 * pages as ordinary `Page` + `Section` rows, and they start rendering here with no template file
 * touched and no route added.
 *
 * Until those rows exist, a KNOWN legal slug renders a short Arabic "قيد التجهيز" page, noindex,
 * instead of a 404. A footer link that a compliance requirement forces onto every page must not
 * lead to a dead end — a broken privacy link is worse than an honest "we are preparing this",
 * both for the visitor and for the merchant whose site it is.
 *
 * Any OTHER unknown slug is a genuine 404.
 */
export const dynamic = 'force-dynamic';

interface PageProps {
  params: Promise<{ slug: string }>;
}

interface LoadedPage {
  title: string;
  metaTitle: string | null;
  metaDescription: string | null;
  sections: Array<{ id: string; type: SectionType; sort: number; config: Record<string, unknown> }>;
}

/**
 * `home` is not a content page — it is the section source for `/`.
 *
 * Serving it here too would publish the whole home arrangement at a second indexable URL with a
 * canonical pointing at itself: duplicate content competing with the page it is a copy of, on a
 * shop whose entire search presence is one storefront. `sitemap.xml` already skips it, so without
 * this the two disagreed about what the site is.
 */
const RESERVED_SLUGS = new Set(['home']);

async function loadPage(tenantId: string, slug: string): Promise<LoadedPage | null> {
  if (RESERVED_SLUGS.has(slug)) return null;

  const db = tenantDb(tenantId, PUBLIC_ACTOR);

  const row = await db.page.findFirst({
    where: { tenantId, slug, published: true },
    select: {
      title: true,
      metaTitle: true,
      metaDescription: true,
      sections: {
        where: { enabled: true },
        select: { id: true, type: true, sort: true, config: true },
        orderBy: { sort: 'asc' },
      },
    },
  });

  if (!row) return null;

  return {
    title: row.title,
    metaTitle: row.metaTitle,
    metaDescription: row.metaDescription,
    // Same treatment as the home page's sections: a type this build cannot render is skipped and
    // a config that no longer fits its schema falls back to defaults. Throwing here would 500
    // every legal page on the site — the pages a compliance requirement links from every footer.
    sections: row.sections
      .filter((section) => isSectionType(section.type))
      .map((section) => ({
        id: section.id,
        type: section.type as SectionType,
        sort: section.sort,
        config: normaliseSectionConfig(section.type as SectionType, section.config),
      })),
  };
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const surface = await requireStorefront();
  const context = await loadStorefrontContext(surface);
  const { slug } = await params;

  const page = await loadPage(context.tenantId, slug);

  if (!page) {
    return storefrontMetadata({
      context,
      title: t('storefront', 'legal.pending.title'),
      path: `/p/${slug}`,
      noindex: true,
      suspended: surface.isSuspended,
    });
  }

  return storefrontMetadata({
    context,
    title: page.metaTitle ?? page.title,
    description: page.metaDescription ?? undefined,
    path: `/p/${slug}`,
    suspended: surface.isSuspended,
  });
}

export default async function ContentPage({ params }: PageProps) {
  const surface = await requireStorefront();
  if (surface.isSuspended) return null;

  const { slug } = await params;
  const context = await loadStorefrontContext(surface);
  const page = await loadPage(context.tenantId, slug);

  if (!page && !isLegalSlug(slug)) notFound();

  const consent = readConsentCookie((await cookies()).get(CONSENT_COOKIE)?.value);
  const analytics = analyticsDecision({
    featureEnabled: context.flags.analytics,
    consentGranted: consent.granted,
    websiteId: context.site.umamiWebsiteId,
    scriptUrl: getEnv().UMAMI_SCRIPT_URL,
  });

  return (
    <StorefrontShell
      context={context}
      analytics={analytics}
      consentAnswered={consent.answered}
      /*
        Phase 9. Both gates — the feature and the consent cookie — resolved by the page, because
        only the page holds the cookie. `path` is the route's own shape rather than
        `location.pathname`, which would report the proxy's internal `/site/…` rewrite.
      */
      beacon={{
        enabled: beaconDecision({
          featureEnabled: context.flags.visitorAnalytics,
          consentGranted: consent.granted,
        }).enabled,
        path: `/p/${slug}`,
      }}
    >
      <section className="sf-block">
        <div className="sf-shell">
          <div className="sf-block__head">
            <h1 className="sf-block__title">
              {page ? page.title : t('storefront', 'legal.pending.title')}
            </h1>
          </div>
          {page ? null : <p className="sf-note">{t('storefront', 'legal.pending.body')}</p>}
        </div>
      </section>

      {page ? <SectionList context={context} sections={page.sections} /> : null}
    </StorefrontShell>
  );
}
