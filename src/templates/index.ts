/**
 * `src/templates` — A2's public surface.
 *
 * B2's appearance screens and its live preview consume the registry and the token helpers from
 * here rather than reaching into a template folder, so the three implementations stay free to
 * change shape. Nothing in this folder imports from `src/app`.
 */
export { TEMPLATE_IMPLEMENTATIONS, FALLBACK_TEMPLATE_KEY, getTemplate, allTemplates } from './registry';
export { templateCssVars, deriveColorTokens, readableOn, isDarkColor, fontUrl } from './tokens';
export { StorefrontShell, type StorefrontShellProps } from './shell';
export { SectionRenderer, SectionList } from './sections';
export { pluralCount } from './i18n';
export { SECTION_ANCHORS } from './section-anchors';
export { buildDefaultSections, type DefaultSectionInput } from './lib/default-sections';
export { isSectionType, normaliseSectionConfig } from './lib/section-config';
export {
  LEGAL_PAGES,
  LEGAL_SLUGS,
  isLegalSlug,
  legalPagesFor,
  legalHref,
  type LegalPageDescriptor,
} from './lib/legal';
export { analyticsDecision, type AnalyticsDecision, type AnalyticsDecisionInput } from './lib/analytics';
export { CUSTOM_HTML_FEATURE_KEY, isCustomHtmlAllowed } from './lib/custom-html-gate';
export { resolveMapTarget, type MapSource, type MapTarget } from './lib/map-links';
export {
  normaliseWhatsappNumber,
  buildOrderUrl,
  fillOrderMessage,
  whatsappUrl,
} from './lib/whatsapp';
export { sanitizeHtml } from './lib/sanitize-html';
export {
  storeJsonLd,
  productJsonLd,
  breadcrumbJsonLd,
  serialiseJsonLd,
  agorotToPriceString,
  type JsonLd,
} from './lib/seo';
export { JsonLdScript } from './components/json-ld';
export { ProductCard } from './components/product-card';
export { SocialLinks, isRenderableSocialUrl } from './components/social-links';
export { MediaImage } from './components/media-image';
export { WhatsappOrder } from './components/whatsapp-order';
export { CheckoutForm, type CheckoutFormProps, type CheckoutLabels } from './components/checkout-form';
export type { TemplateDefinition, TemplateTokens, TemplateLayout, TemplateFont } from './types';
export type * from './view-model';
