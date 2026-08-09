import { parseSectionConfig, type SectionConfig } from '@/shared/site-contract';
import type { StorefrontContext, StorefrontSection } from '../view-model';
import { AboutSection } from './about';
import { AnnouncementsSection } from './announcements';
import { CategoriesSection } from './categories';
import { ContactWhatsappSection } from './contact-whatsapp';
import { CustomHtmlSection } from './custom-html';
import { GallerySection } from './gallery';
import { HeroSection } from './hero';
import { MapSection } from './map';
import { ProductsGridSection } from './products-grid';
import { TestimonialsSection } from './testimonials';

/**
 * The section renderer.
 *
 * The switch is exhaustive over `SectionType` and TypeScript proves it: adding a section type to
 * `site-contract` without handling it here is a typecheck failure, not a silently missing block
 * on a merchant's live site.
 *
 * Every config is re-parsed through its own zod schema at the boundary. The loader already did
 * it, so this is belt and braces — but it is what lets each component take a TYPED config
 * instead of `Record<string, unknown>`, and it is what makes a stored config written by an older
 * version of the dashboard render with today's defaults instead of `undefined`.
 */
export function SectionRenderer({
  context,
  section,
}: {
  context: StorefrontContext;
  section: StorefrontSection;
}) {
  switch (section.type) {
    case 'hero':
      return (
        <HeroSection context={context} config={config<'hero'>('hero', section)} />
      );
    case 'products_grid':
      return (
        <ProductsGridSection
          context={context}
          config={config<'products_grid'>('products_grid', section)}
        />
      );
    case 'categories':
      return (
        <CategoriesSection context={context} config={config<'categories'>('categories', section)} />
      );
    case 'about':
      return <AboutSection context={context} config={config<'about'>('about', section)} />;
    case 'gallery':
      return <GallerySection context={context} config={config<'gallery'>('gallery', section)} />;
    case 'testimonials':
      return (
        <TestimonialsSection
          context={context}
          config={config<'testimonials'>('testimonials', section)}
        />
      );
    case 'announcements':
      return (
        <AnnouncementsSection
          context={context}
          config={config<'announcements'>('announcements', section)}
        />
      );
    case 'contact_whatsapp':
      return (
        <ContactWhatsappSection
          context={context}
          config={config<'contact_whatsapp'>('contact_whatsapp', section)}
        />
      );
    case 'map':
      return <MapSection context={context} config={config<'map'>('map', section)} />;
    case 'custom_html':
      return (
        <CustomHtmlSection context={context} config={config<'custom_html'>('custom_html', section)} />
      );
    default: {
      // Exhaustiveness: `never` here is the compiler proving every section type is handled.
      const unreachable: never = section.type;
      return unreachable;
    }
  }
}

function config<T extends Parameters<typeof parseSectionConfig>[0]>(
  type: T,
  section: StorefrontSection,
): SectionConfig<T> {
  return parseSectionConfig(type, section.config) as SectionConfig<T>;
}

/** Render a whole page's worth of sections in sort order. */
export function SectionList({
  context,
  sections,
}: {
  context: StorefrontContext;
  sections: StorefrontSection[];
}) {
  return (
    <>
      {sections.map((section) => (
        <SectionRenderer key={section.id} context={context} section={section} />
      ))}
    </>
  );
}
