import type { Metadata } from 'next';
import { LOCALE } from '@/shared/i18n';
import type { StorefrontContext } from '@/templates';

/**
 * Baseline metadata — identical on EVERY plan.
 *
 * `seo_tools` is احترافي-only and gates the editable title/description fields B2 builds. It does
 * NOT gate this: docs/PHASES.md is explicit that "a basic-plan site with broken metadata is a
 * bug". Nothing in this file asks what plan the tenant is on, and there is no code path by which
 * a plan could remove a tag.
 *
 * What `Site.metaTitle` / `metaDescription` do is OVERRIDE the derived values when they exist.
 * They can only exist if the merchant had the feature when they were written, which is where the
 * gate belongs — at the write, not at the read. A merchant downgraded from احترافي keeps the
 * title they already wrote instead of watching their search result change overnight.
 */

export interface StorefrontMetadataInput {
  context: StorefrontContext;
  /** Page-specific title. The site name is appended by the template below. */
  title?: string | null;
  description?: string | null;
  /** Public path, e.g. `/products/zaatar`. Used for the canonical URL. */
  path: string;
  /** Overrides the page's own image (a product photo). */
  imageUrl?: string | null;
  /** Suspended sites pass true; demos are detected from the context. */
  suspended?: boolean;
  /**
   * Anything that must not be indexed for a reason of its own — a legal page Phase 6 has not
   * filled in yet, or a product that vanished between the metadata pass and the render.
   */
  noindex?: boolean;
}

/** Search results truncate around 160 characters; a longer description is wasted work. */
function clamp(value: string, max = 160): string {
  const clean = value.replace(/\s+/g, ' ').trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1).trimEnd()}…`;
}

export function storefrontMetadata({
  context,
  title,
  description,
  path,
  imageUrl,
  suspended = false,
  noindex: forceNoindex = false,
}: StorefrontMetadataInput): Metadata {
  const { site, origin } = context;

  /**
   * A demo or a suspended site is noindex, always.
   *
   * This is one of the three layers Q8 asks for — the other two are the per-hostname robots.txt
   * in this subtree and the `X-Robots-Tag` header. The token is the MECHANISM that keeps a demo
   * private; these layers exist for the crawler that got the URL some other way.
   */
  const noindex = context.isDemo || suspended || forceNoindex;

  const pageTitle = title?.trim() || site.metaTitle?.trim() || site.name;
  const derivedDescription =
    description?.trim() ||
    site.metaDescription?.trim() ||
    site.tagline?.trim() ||
    site.about?.trim() ||
    site.name;

  const canonical = `${origin}${path.startsWith('/') ? path : `/${path}`}`;
  const image = imageUrl ?? site.ogImageUrl ?? site.logo?.src ?? null;

  return {
    title: title ? { absolute: `${pageTitle} · ${site.name}` } : { absolute: pageTitle },
    description: clamp(derivedDescription),
    alternates: { canonical },
    robots: noindex
      ? { index: false, follow: false, nocache: true, googleBot: { index: false, follow: false } }
      : { index: true, follow: true, googleBot: { index: true, follow: true } },
    openGraph: {
      type: 'website',
      siteName: site.name,
      title: pageTitle,
      description: clamp(derivedDescription),
      url: canonical,
      locale: LOCALE,
      ...(image ? { images: [{ url: image }] } : {}),
    },
    twitter: {
      card: image ? 'summary_large_image' : 'summary',
      title: pageTitle,
      description: clamp(derivedDescription),
      ...(image ? { images: [image] } : {}),
    },
  };
}
