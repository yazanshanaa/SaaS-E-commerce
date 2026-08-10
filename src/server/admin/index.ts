/**
 * `src/server/admin` — everything the Super Admin panel does on the server.
 *
 * The panel's route files are a rendering layer over this module and hold no business logic of
 * their own. That split is what makes the two rules that matter testable without a browser:
 * every entry point takes an `AdminContext` (so the guard cannot be forgotten), and every
 * lifecycle change goes through `src/server/billing` (so invariant 5 holds by construction).
 */

export {
  requireAdminContext,
  optionalAdminContext,
  ForbiddenError,
  UnauthorizedError,
  type AdminContext,
} from './context';

export {
  auditTenantAction,
  auditPlatformAction,
  listAuditLogs,
  type AuditEntry,
  type AuditFilters,
  type AuditPage,
  type AuditRow,
} from './audit';

export {
  RECURRING_PAYMENT_KINDS,
  NON_RECURRING_PAYMENT_KINDS,
  amortisedMonthlyAgorot,
  collectedAgorot,
  monthOrdinal,
  monthOrdinalOfKey,
  monthlyRecurringRevenueAgorot,
  nonRecurringAgorot,
  recognisedRecurringAgorot,
  type ActiveSubscriptionPrice,
  type BillingPeriodLike,
  type RevenuePayment,
} from './revenue';

export {
  analyticsConfig,
  isAnalyticsConfigured,
  provisionAnalyticsWebsite,
  resetAnalyticsTokenCache,
  websiteVisits,
  type VisitStats,
} from './analytics';

export { getOverview, type Overview, type OverviewEvent } from './overview';

export {
  createAccountFromAdmin,
  createAccountSchema,
  extendAccount,
  extendAccountRetention,
  getAccount,
  listAccounts,
  provisionAccountAnalytics,
  purgeAccount,
  reactivateAccount,
  sendOwnerPasswordLink,
  suspendAccount,
  type AccountDetail,
  type AccountFilters,
  type AccountList,
  type AccountListRow,
  type AccountUsage,
} from './accounts';

export {
  FEATURE_KINDS,
  clearCapabilityOverride,
  clearFeatureOverride,
  getAccessMatrix,
  parseFeatureValue,
  setCapabilityOverride,
  setFeatureOverride,
  type AccessMatrix,
  type CapabilityRow,
  type FeatureKind,
  type FeatureRow,
  type StoredFeatureValue,
} from './access';

export {
  DEFAULT_PAGE_SLUG,
  deleteAnnouncement,
  getSiteContent,
  moveSection,
  saveAnnouncement,
  saveAnnouncementBar,
  saveMapLocation,
  saveSocialLinks,
  seedDefaultSections,
  setSectionEnabled,
  type SiteContent,
} from './site-content';

export {
  CAPABILITY_PAYLOAD_SCHEMAS,
  safeParseCapabilityPayload,
  type CapabilityPayload,
} from './capability-payloads';

export {
  CHANGE_REQUEST_ADDON_AGOROT,
  applyChangeRequest,
  listChangeRequests,
  recordChangeRequestAddon,
  rejectChangeRequest,
  type ChangeRequestFilters,
  type ChangeRequestRow,
} from './change-requests';

export {
  deletePlan,
  getPlan,
  listPlans,
  planSchema,
  savePlan,
  type PlanDetail,
  type PlanListRow,
  type PlanMatrixInput,
} from './plans';

export {
  PAYMENT_KINDS,
  PAYMENT_METHODS,
  listAttachableMedia,
  listPayments,
  manualPaymentSchema,
  recordManualPayment,
  type PaymentRow,
} from './payments';

export {
  consumeImpersonationHandoff,
  startImpersonation,
  stopImpersonation,
  type ImpersonationStart,
  type ImpersonationStop,
} from './impersonation';

export {
  IDLE,
  checkbox,
  failure,
  fieldErrorsFromZod,
  integerField,
  invalid,
  ok,
  parseJerusalemInput,
  text,
  textList,
  type ActionState,
  type FieldError,
} from './validation';
