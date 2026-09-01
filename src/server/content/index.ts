/**
 * `src/server/content` — Phase 9 Track B's homepage content, as services.
 *
 * Same split as `src/server/catalogue`: the dashboard's `_lib/*` wrappers own transactions, audit
 * rows and i18n keys, the storefront's `_data/*` loaders own the view model, and what lives HERE is
 * every rule the two must agree on — the banner publish gate, the weekday/time validation, the strip
 * colour resolution, the caps. A rule implemented twice is a rule that will disagree with itself,
 * and this one has three consumers: the merchant dashboard, the storefront, and the super admin's
 * change-request apply path.
 */

export {
  BRANDING_SLOTS,
  brandingPayloadSchema,
  brandingSchema,
  loadBranding,
  saveBranding,
  type BrandingInput,
  type BrandingRow,
  type BrandingSlot,
  type SaveBrandingResult,
} from './branding';

export {
  MAX_BANNERS,
  bannerInputSchema,
  bannersPayloadFrom,
  bannersPayloadSchema,
  deleteBanner,
  isRenderableBanner,
  listBanners,
  renderableBanners,
  saveBanner,
  type BannerErrorCode,
  type BannerInput,
  type BannerRow,
  type SaveBannerResult,
} from './banners';

export {
  MAX_TRUST_BADGES,
  TRUST_ICON_KEYS,
  deleteTrustBadge,
  isTrustIconKey,
  listTrustBadges,
  renderableTrustBadges,
  saveTrustBadge,
  trustBadgeInputSchema,
  trustBadgesPayloadFrom,
  trustBadgesPayloadSchema,
  type TrustBadgeErrorCode,
  type TrustBadgeInput,
  type TrustBadgeRow,
  type TrustIconKey,
} from './trust-badges';

export {
  TIME_PATTERN,
  WEEKDAYS,
  fullWeek,
  isOpenNow,
  isWeekday,
  jerusalemWallClock,
  loadOpeningHours,
  openingHoursPayloadFrom,
  openingHoursPayloadSchema,
  openingHoursSchema,
  saveOpeningHours,
  type OpeningDayInput,
  type OpeningHoursInput,
  type OpeningHoursRow,
  type OpeningHoursView,
  type Weekday,
} from './opening-hours';

export {
  MAX_STORE_STATS,
  deleteStoreStat,
  listStoreStats,
  renderableStoreStats,
  saveStoreStat,
  storeStatInputSchema,
  storeStatsPayloadFrom,
  storeStatsPayloadSchema,
  type StoreStatErrorCode,
  type StoreStatInput,
  type StoreStatRow,
} from './store-stats';

export {
  STRIP_COLORS,
  announcementBarColorSchema,
  loadAnnouncementBarColor,
  loadHomeStrip,
  resolveStrip,
  saveAnnouncementBarColor,
  saveHomeStrip,
  stripStyle,
  type HomeStripRow,
  type StripColor,
  type StripStyle,
  type StripView,
} from './strips';
