import type { SectionType } from '@/shared/site-contract';

/**
 * The shape of a generated legal page, before it becomes rows.
 *
 * A page is a TITLE plus a list of CLAUSES, and a clause is a heading and a body of blank-line
 * separated Arabic paragraphs. That maps exactly onto what the storefront already renders: the
 * `/p/{slug}` route prints the page title as the single `h1`, and each clause becomes an `about`
 * section — `h2` plus `<p>` per paragraph (`src/templates/sections/about.tsx`). Nothing new had to
 * be added to `site-contract` and no template file was touched, which is the contract A2 left
 * behind in `src/templates/lib/legal.ts`.
 *
 * `liveSections` is the escape hatch for facts that must NOT be frozen into a row. The business
 * identity page needs the shop's address, phone and WhatsApp number, and baking those into a
 * section config would mean a merchant who corrects their phone number keeps publishing the old
 * one until something remembers to regenerate. The `contact_whatsapp` and `map` sections already
 * read `Site` live on every render, so the identity page delegates to them and the page can never
 * be stale about the one thing it exists to state.
 */

export interface LegalClause {
  /** Rendered as the `h2` of its block. */
  heading: string;
  /** Paragraphs separated by a blank line, exactly as `AboutSection` splits them. */
  body: string;
}

export interface LegalLiveSection {
  type: SectionType;
  config: Record<string, unknown>;
}

export interface LegalPageSpec {
  /** URL segment under `/p/`, from `LEGAL_PAGES` in `src/templates/lib/legal.ts`. */
  slug: string;
  title: string;
  metaDescription: string;
  clauses: LegalClause[];
  /** Appended after the clauses. Reads live tenant data at render time — never frozen. */
  liveSections?: LegalLiveSection[];
  /** `Page.sort`, assigned from the footer's own order so a page list reads the same way. */
  sort?: number;
}

/**
 * Everything the generated copy is allowed to assert, gathered once per sync.
 *
 * Every field here exists because some sentence in `content.ts` would otherwise be a guess. The
 * rule for adding one: if the copy says it, this object proves it — and if this object cannot
 * prove it, the copy does not say it.
 */
export interface LegalFacts {
  tenantId: string;
  /** The trading name, as the merchant set it. Used where the copy must name the controller. */
  siteName: string;
  isDemo: boolean;

  /**
   * `Site.sellingEnabled` ALONE, because this is what decides which PAGES exist.
   *
   * It has to be this and not the fuller predicate below: the footer calls
   * `legalPagesFor(site.sellingEnabled)` (`src/templates/components/site-footer.tsx`), so a
   * generator that used a stricter test would leave the returns and "إلغاء معاملة" links pointing
   * at pages it had decided not to write — and a permanent legal footer link that lands on
   * "قيد التجهيز" is exactly the dead end A2's fallback exists to soften, not to excuse.
   */
  sellingEnabled: boolean;

  /**
   * The storefront's OWN four-conjunct checkout predicate, which is the only thing that actually
   * turns customer-data collection on (`src/app/site/_data/context.ts` → `flags.payments`).
   *
   * Separate from `sellingEnabled` on purpose. A shop can have selling switched on with no enabled
   * gateway row, or with the `payment_gateway` feature turned off by an admin — and in that state
   * the product page renders the WhatsApp block, no form, and collects nothing. Branching the
   * privacy copy on `sellingEnabled` alone would publish a policy describing a collection that
   * cannot happen, which is the same class of error as omitting one that does.
   */
  collectsOrders: boolean;

  /** `can(tenantId, 'analytics')`. False means the Umami tag is never in the HTML at all. */
  analyticsEnabled: boolean;
  /** `can(tenantId, 'push_notifications')` AND a configured VAPID key pair. */
  pushEnabled: boolean;

  /**
   * The tenant's enabled gateway, and ONLY when its adapter is actually `active`.
   *
   * A scaffolded provider processes nothing — `createPaymentLink` throws and the settlement route
   * refuses it — so naming Meshulam, Tranzila or PayPal in a processors list would be a false
   * disclosure in the direction nobody checks for: claiming data leaves when it does not.
   */
  activeGatewayProvider: string | null;
  /** True when that active adapter transmits nothing to anyone (the manual cash/transfer one). */
  activeGatewayIsLocal: boolean;

  // --- Platform-level facts, identical for every tenant ------------------------
  /** `RETENTION_DAYS` — how long a suspended shop's data is kept before the purge. */
  retentionDays: number;
  /** `DEMO_REQUEST_RETENTION_DAYS` — the demo-request row's own ceiling. */
  demoRequestRetentionDays: number;
  /** Q10: dumps every 6 hours, kept 14 days, then removed by an R2 lifecycle rule. */
  backupIntervalHours: number;
  backupRetentionDays: number;
  /**
   * How long the deletion record survives the deletion it proves. Phase 6 gave both of the global
   * tables that outlive a tenant a lifetime, because "forever" is not a retention policy — and a
   * privacy page that discloses a surviving record without a ceiling has disclosed a permanent one.
   */
  tombstoneRetentionDays: number;
  /** How long a delivered event's payload is kept in the global outbox log. */
  webhookRetentionDays: number;
  /** How long the consent cookie lasts, in days — the visitor's own renewal clock. */
  consentCookieDays: number;
  /**
   * Worst case, in days, before a DELETED image stops being served from a cache.
   *
   * A carried-forward Group A item, and the reason it is a number in this object rather than a
   * sentence in the copy: the value is computed from the `Cache-Control` header the media pipeline
   * actually sends (`src/server/media/cache.ts`), so a header changed without the policy cannot
   * leave the policy quietly false. Saying "deleted immediately" would be false for this window.
   */
  mediaCacheDays: number;
  /** Where a data subject writes. The DSR box on `app.{DOMAIN}`. */
  dsrUrl: string;
  /** The address on the DSR page, for a subject who would rather send mail. */
  contactEmail: string;
  /** Which processors are actually configured in THIS deployment. */
  processors: LegalProcessorKey[];
}

/**
 * The processors a generated policy may name.
 *
 * Deliberately a closed set rather than free text: a processor that appears in the copy has to
 * appear here, which means it has to be justified against real code in `facts.ts`. Two of these
 * are self-hosted and are listed for exactly that reason — a policy that quietly omits where the
 * analytics live is as incomplete as one that omits a third party.
 */
export const LEGAL_PROCESSOR_KEYS = [
  'cloudflare',
  'resend',
  'smtp',
  'umami',
  'pushService',
  'sentry',
  'n8n',
  'whatsapp',
  'gateway',
] as const;

export type LegalProcessorKey = (typeof LEGAL_PROCESSOR_KEYS)[number];
