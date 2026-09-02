/**
 * `src/templates` — A2's public surface.
 *
 * B2's appearance screens and its live preview consume the registry and the token helpers from
 * here rather than reaching into a template folder, so the five implementations stay free to
 * change shape. Nothing in this folder imports from `src/app`.
 */
export { TEMPLATE_IMPLEMENTATIONS, FALLBACK_TEMPLATE_KEY, getTemplate, allTemplates } from './registry';
export {
  templateCssVars,
  templateThemeCss,
  deriveColorTokens,
  counterpartGround,
  flipGround,
  readableOn,
  isDarkColor,
  fontUrl,
  type TemplateGround,
} from './tokens';
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
export { AddToCart, type AddToCartLabels, type AddToCartProps } from './components/add-to-cart';
export { CartBadge, type CartBadgeLabels } from './components/cart-badge';
export { CartView, type CartViewLabels } from './components/cart-view';
export { CheckoutView, type CheckoutViewLabels, type CheckoutViewProps } from './components/checkout-view';
export { TrackingView, type TrackingViewLabels } from './components/tracking-view';
export {
  addToCart,
  cartCount,
  clearCart,
  readCart,
  removeFromCart,
  setCartQuantity,
  useCart,
  type CartLine,
  type UseCartResult,
} from './lib/cart';
/**
 * Phase 9's components, on the barrel for the same reason the fourteen above are: `src/app` imports
 * from `@/templates`, not from `@/templates/components/…`.
 *
 * The eight new SECTIONS stay unexported, exactly like the ten before them — `SectionRenderer` is
 * the door, and a page that reached past it would bypass `hiddenSectionTypes` and render a block an
 * admin had switched invisible.
 */
export { DiscountBadge, PriceWithDiscount, discountPercent, type DiscountBadgeProps } from './components/discount-badge';
export { VariantPicker, type VariantChoice, type VariantPickerProps } from './components/variant-picker';
export { SizeGuide, type SizeGuideProps, type SizeGuideRow } from './components/size-guide';
export { CareDetails, type CareDetailsProps } from './components/care-details';
export { HomeStrip, type HomeStripProps, type HomeStripStyle } from './components/home-strip';
export { BannerCarousel, type BannerCarouselLabels } from './components/banner-carousel';
export { CategoryNav, CATEGORY_NAV_CAP, type CategoryNavProps } from './components/category-nav';
export { Beacon, type BeaconProps } from './components/beacon';
export { SearchBox, type SearchBoxLabels, type SearchBoxProps } from './components/search-box';
export type {
  TemplateDefinition,
  TemplateTokens,
  TemplateLayout,
  TemplateFont,
  TemplateSignature,
} from './types';
export type * from './view-model';
