import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { getEnv } from '@/env';
import {
  analyticsDecision,
  JsonLdScript,
  SectionList,
  storeJsonLd,
  StorefrontShell,
} from '@/templates';
import { CONSENT_COOKIE, readConsentCookie } from './_data/consent';
import { loadStorefrontContext } from './_data/context';
import { storefrontMetadata } from './_data/metadata';
import { requireStorefront } from './_data/surface';

/**
 * The storefront home page.
 *
 * Dynamic because tenancy is resolved from request headers — the DATA behind it is what gets
 * cached, keyed by tenantId and tagged for invalidation (see `_data/cache.ts`). Marking the page
 * static would mean one merchant's HTML served on another's hostname, which is the single worst
 * bug this platform could ship.
 */
export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const surface = await requireStorefront();
  if (surface.isSuspended) {
    const context = await loadStorefrontContext(surface);
    return storefrontMetadata({ context, path: '/', suspended: true });
  }

  const context = await loadStorefrontContext(surface);
  return storefrontMetadata({ context, path: '/' });
}

export default async function StorefrontHomePage() {
  const surface = await requireStorefront();
  // The layout renders the pause page; there is nothing for this route to fetch.
  if (surface.isSuspended) return null;

  const context = await loadStorefrontContext(surface);
  const consent = readConsentCookie((await cookies()).get(CONSENT_COOKIE)?.value);

  const analytics = analyticsDecision({
    featureEnabled: context.flags.analytics,
    consentGranted: consent.granted,
    websiteId: context.site.umamiWebsiteId,
    scriptUrl: getEnv().UMAMI_SCRIPT_URL,
  });

  const hasHero = context.sections.some((section) => {
    return section.type === 'hero';
  });

  return (
    <StorefrontShell
      context={context}
      analytics={analytics}
      consentAnswered={consent.answered}
      current="home"
    >
      {/*
        Structured data, withheld from a demo: a rich snippet is the artefact that survives
        longest after a page stops being crawlable, so it is exactly the wrong thing to emit
        from a site that is noindex on three layers.
      */}
      {context.isDemo ? null : <JsonLdScript data={storeJsonLd(context)} />}

      {/*
        The hero owns the page's single h1. A merchant who removed the hero section would
        otherwise leave the page with no level-one heading at all — an axe finding produced by a
        drag-and-drop, so the shop's name stands in, visually hidden.
      */}
      {hasHero ? null : <h1 className="sf-vh">{context.site.name}</h1>}

      <SectionList context={context} sections={context.sections} />
    </StorefrontShell>
  );
}
