import { CONSENT_COOKIE } from '@/app/site/_data/consent';
import { legalText } from './text';
import { LEGAL_PAGES } from '@/templates/lib/legal';
import type { LegalClause, LegalFacts, LegalPageSpec, LegalProcessorKey } from './types';

/**
 * The generated Arabic legal pages, as a pure function of `LegalFacts`.
 *
 * Every sentence lives in `messages/ar/legal.json`, exactly like every other string on this
 * platform — a long legal text is not an exception to the i18n rule, it is the case that makes the
 * rule worth having. What lives HERE is only which clauses a given site gets, and that decision is
 * made from facts read out of the running system rather than from a plan name.
 *
 * The three branches that matter:
 *   - `collectsOrders` decides whether the privacy policy describes collecting a customer's name
 *     and phone number. It is the storefront's own four-conjunct predicate, not `sellingEnabled`
 *     (see `types.ts`) — a shop with selling switched on and no enabled gateway draws no form and
 *     collects nothing, and a policy claiming otherwise is as wrong as one that omits it;
 *   - `sellingEnabled` decides which PAGES exist, because that is what the footer asks;
 *   - `processors` names only what this deployment is actually configured to use.
 */

const HASH_ALGORITHM = 'argon2id';

function clause(key: string, params?: Record<string, string | number>): LegalClause {
  return {
    heading: legalText(`${key}.h`, params),
    body: legalText(`${key}.b`, params),
  };
}

/**
 * The processor list, rendered as one paragraph per processor under a single heading.
 *
 * A list rather than a table because `about` renders paragraphs, and because a table of four
 * columns is unreadable on the phone a shop owner's customer is holding. Each line names the
 * party, what it does, and what reaches it — which is the shape a data-subject request probes.
 */
function processorsClause(facts: LegalFacts): LegalClause {
  const lines = facts.processors.map((key) => processorLine(key, facts));

  /**
   * The local-gateway line is not a processor entry — it is the explicit statement that there is
   * no payment processor at all. Saying nothing here would read as an omission on the one topic a
   * customer most expects to see covered.
   */
  if (facts.collectsOrders && facts.activeGatewayIsLocal) {
    lines.push(legalText('processors.gatewayLocal'));
  }

  return {
    heading: legalText('privacy.processors.h'),
    body: [legalText('privacy.processors.b'), ...lines].join('\n\n'),
  };
}

function processorLine(key: LegalProcessorKey, facts: LegalFacts): string {
  if (key === 'gateway') {
    return legalText('processors.gateway', { provider: facts.activeGatewayProvider ?? '' });
  }
  return legalText(`processors.${key}`);
}

function privacyPage(facts: LegalFacts): LegalPageSpec {
  const name = facts.siteName;

  const clauses: LegalClause[] = [
    clause('privacy.intro', { name }),
    clause('privacy.collectBase'),
  ];

  if (facts.analyticsEnabled) clauses.push(clause('privacy.collectAnalytics'));
  if (facts.pushEnabled) clauses.push(clause('privacy.collectPush'));
  clauses.push(
    facts.collectsOrders ? clause('privacy.collectOrders') : clause('privacy.collectNoOrders'),
  );

  clauses.push(
    clause('privacy.whatsapp'),
    clause('privacy.cookies', {
      cookie: CONSENT_COOKIE,
      consentDays: facts.consentCookieDays,
    }),
    processorsClause(facts),
    clause('privacy.processorsRegion'),
    clause('privacy.retentionVisitor', {
      consentDays: facts.consentCookieDays,
      demoRequestDays: facts.demoRequestRetentionDays,
      mediaCacheDays: facts.mediaCacheDays,
    }),
    clause('privacy.retentionMerchant', {
      retentionDays: facts.retentionDays,
      backupHours: facts.backupIntervalHours,
      backupDays: facts.backupRetentionDays,
    }),
    clause('privacy.deletionRecord', {
      tombstoneDays: facts.tombstoneRetentionDays,
      webhookDays: facts.webhookRetentionDays,
    }),
    clause('privacy.rights', { dsrUrl: facts.dsrUrl, email: facts.contactEmail }),
    clause('privacy.security', { hash: HASH_ALGORITHM }),
  );

  return {
    slug: 'privacy',
    title: legalText('privacy.title'),
    metaDescription: legalText('privacy.meta', { name }),
    clauses,
  };
}

function termsPage(facts: LegalFacts): LegalPageSpec {
  const name = facts.siteName;

  const clauses: LegalClause[] = [clause('terms.intro', { name }), clause('terms.content')];

  clauses.push(facts.collectsOrders ? clause('terms.ordersGateway') : clause('terms.ordersWhatsapp'));
  if (facts.sellingEnabled) clauses.push(clause('terms.returnsPointer'));

  clauses.push(clause('terms.ip'), clause('terms.liability'), clause('terms.law'), clause('terms.changes'));

  return {
    slug: 'terms',
    title: legalText('terms.title'),
    metaDescription: legalText('terms.meta', { name }),
    clauses,
  };
}

/**
 * The business identity page, which is the ONE page that must never be stale.
 *
 * Its whole purpose is telling a customer who they are dealing with and how to reach them, so the
 * address and the numbers are not frozen into a section config: the page appends the existing
 * `contact_whatsapp` section, which reads `Site` on every render. A merchant who corrects their
 * phone number is correcting it here too, with nothing to regenerate and nothing to forget.
 */
function identityPage(facts: LegalFacts): LegalPageSpec {
  const name = facts.siteName;

  return {
    slug: 'business-identity',
    title: legalText('identity.title'),
    metaDescription: legalText('identity.meta', { name }),
    clauses: [
      clause('identity.intro', { name }),
      clause('identity.platform'),
      clause('identity.contactNote'),
    ],
    /**
     * `contact_whatsapp` and NOT `map`.
     *
     * The contact block already renders the phone, the opening hours, the address and the email
     * straight off `Site`, which is the whole of what a business identity page has to publish. The
     * map section would have added a link and a risk: `hiddenSectionTypes` contains `map` whenever
     * the `map_location` capability is off (`src/app/site/_data/context.ts`), so an admin toggle
     * made for an unrelated reason would silently delete half of a page a compliance requirement
     * puts in every footer. `contact_whatsapp` is never hidden by any capability.
     */
    liveSections: [
      {
        type: 'contact_whatsapp',
        config: {
          title: legalText('identity.contactSection.title'),
          body: legalText('identity.contactSection.body'),
        },
      },
    ],
  };
}

function accessibilityPage(facts: LegalFacts): LegalPageSpec {
  return {
    slug: 'accessibility',
    title: legalText('accessibility.title'),
    metaDescription: legalText('accessibility.meta', { name: facts.siteName }),
    clauses: [
      clause('accessibility.intro'),
      clause('accessibility.standard'),
      clause('accessibility.done'),
      clause('accessibility.limits'),
      clause('accessibility.report', { email: facts.contactEmail }),
    ],
  };
}

function returnsPage(facts: LegalFacts): LegalPageSpec {
  const name = facts.siteName;

  return {
    slug: 'returns',
    title: legalText('returns.title'),
    metaDescription: legalText('returns.meta', { name }),
    clauses: [
      clause('returns.intro', { name }),
      clause('returns.right'),
      clause('returns.how'),
      clause('returns.refund'),
      clause('returns.condition'),
      clause('returns.exceptions'),
      clause('returns.defects'),
    ],
  };
}

function cancelPage(facts: LegalFacts): LegalPageSpec {
  const name = facts.siteName;

  return {
    slug: 'cancel-transaction',
    title: legalText('cancel.title'),
    metaDescription: legalText('cancel.meta', { name }),
    clauses: [
      clause('cancel.intro', { name }),
      clause('cancel.how'),
      clause('cancel.what'),
      clause('cancel.pointer'),
    ],
  };
}

const BUILDERS: Record<string, (facts: LegalFacts) => LegalPageSpec> = {
  privacy: privacyPage,
  terms: termsPage,
  'business-identity': identityPage,
  accessibility: accessibilityPage,
  returns: returnsPage,
  'cancel-transaction': cancelPage,
};

/**
 * Build every legal page this site should have, in the footer's own order.
 *
 * The page SET comes from `LEGAL_PAGES` rather than from a list repeated here, so the footer and
 * the generator cannot drift: a link the footer renders is a page this function writes, and a page
 * this function stops writing is a link the footer stops rendering. Adding a seventh legal page is
 * a line in `src/templates/lib/legal.ts` plus a builder above — which is exactly the contract A2
 * left behind.
 */
export function buildLegalPages(facts: LegalFacts): LegalPageSpec[] {
  return LEGAL_PAGES.filter((page) => page.when === 'always' || facts.sellingEnabled).map(
    (page, index) => {
      const builder = BUILDERS[page.slug];
      if (!builder) throw new Error(`No legal page builder for slug "${page.slug}".`);

      const spec = builder(facts);

      /**
       * Two clauses wrap every page, and both are deliberate.
       *
       * The demo notice goes FIRST because a prospect being shown a demo during a sales call must
       * not read a returns policy as a promise from a shop that does not exist. The disclaimer goes
       * LAST on every page because docs/PHASES.md requires it on every page — final legal review is
       * the business owner's responsibility, and a generated policy that does not say so is the
       * platform quietly accepting a liability it cannot carry.
       */
      const clauses = [
        ...(facts.isDemo ? [clause('shared.demoNotice')] : []),
        ...spec.clauses,
        clause('shared.disclaimer', { name: facts.siteName }),
      ];

      return { ...spec, clauses, sort: index };
    },
  );
}
