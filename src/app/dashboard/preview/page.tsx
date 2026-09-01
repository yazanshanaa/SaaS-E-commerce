import { getEnv, storefrontHost } from '@/env';
import { t } from '@/shared/i18n';
import { analyticsDecision, SectionList, StorefrontShell } from '@/templates';
import type { StorefrontContext } from '@/templates';
import { loadTenantData } from '../../site/_data/context';
import { requireMerchantPage } from '../_components/guard';
import { PreviewClickGuard } from './_lib/click-guard';
import { resolvePreviewDraft } from './_lib/draft';
import { withSampleCatalogue } from './_lib/sample';

/**
 * The live preview (Phase 11, Track 11.D / Q28): the tenant's own storefront, rendered with an
 * UNSAVED template and colour selection carried in the URL, inside the appearance screen's
 * same-origin iframe — or full-page as «جرّب على متجري».
 *
 * THE INVARIANTS, in the order they would hurt:
 *
 *   1. READ-ONLY, PROVABLY. This route writes no table, enqueues no job and calls no
 *      revalidation — `tests/unit/phase11-preview.test.ts` greps this folder for the write and
 *      revalidation surfaces (`requestStorefrontRevalidation` / `internalRevalidateUrl` by their
 *      REAL export names) and fails on any of them appearing.
 *   2. TENANT-SCOPED BY THE SESSION, never by a parameter. `requireMerchantPage('appearance')`
 *      resolves the tenant exactly as every other app.* page does; there is no tenantId in the
 *      URL and no admin escape hatch — impersonation already gives the super admin the
 *      merchant's own view. A second merchant's session renders THEIR OWN shop here, never
 *      tenant A's (the e2e case).
 *   3. THE DRAFT IS BOUNDED BY THE PLAN. `resolvePreviewDraft` enforces `templates_allowed` and
 *      `color_mode` with the same rules the save path uses, and anything invalid falls back to
 *      the saved appearance — the preview can neither error over a hand-edited URL nor show a
 *      plan the merchant does not have.
 *
 * Data is the tenant's real catalogue through the merchant's own scoped client
 * (`loadTenantData` — the uncached read, because a preview must reflect the product the
 * merchant added ten seconds ago). An empty catalogue gets the Arabic sample fixture; the
 * appearance screen labels it.
 *
 * `noindex` arrives from the dashboard layout's metadata (the whole surface is noindex), and the
 * framing exception that lets the iframe render this at all is Q37's — one path wide, asserted.
 */
export const dynamic = 'force-dynamic';

export default async function PreviewPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = await requireMerchantPage('appearance');
  const [params, tenant] = await Promise.all([
    searchParams,
    ctx.db.tenant.findUnique({ where: { id: ctx.tenantId }, select: { slug: true } }),
  ]);

  const draft = await resolvePreviewDraft(ctx, params);
  if (!draft || !tenant) return null;

  const data = await loadTenantData(ctx.tenantId, false);
  const env = getEnv();
  const hostname = storefrontHost(tenant.slug);

  const context: StorefrontContext = withSampleCatalogue({
    ...data,
    tenantId: ctx.tenantId,
    slug: tenant.slug,
    hostname,
    origin: `${env.PUBLIC_SCHEME}://${hostname}`,
    isDemo: false,
    // The draft, applied. Everything else — sections, content, media — is the real shop.
    template: draft.template,
    colors: draft.colors,
    /**
     * The interactive extras are OFF in a preview, deliberately: no push key (a subscribe
     * button in an iframe would take a real browser permission for a rehearsal), no PWA
     * manifest or service worker (registering a worker from the dashboard origin against a
     * preview document would outlive the preview), and no cart FAB (its badge reads
     * localStorage state that belongs to the real storefront origin, not to app.*).
     */
    pushPublicKey: null,
    /**
     * No agency credit line in the preview: it is PLATFORM state read per request on the real
     * storefront, and a rehearsal frame is not a page the owner's toggle needs to reach.
     */
    credit: null,
    flags: { ...data.flags, pwa: false, push: false, cart: false },
  });

  return (
    <StorefrontShell
      context={context}
      // Never any tracking in a preview: the decision function with everything off renders no
      // script at all — the same "no script on the page" rule the storefront keeps pre-consent.
      analytics={analyticsDecision({
        featureEnabled: false,
        consentGranted: false,
        websiteId: null,
        scriptUrl: undefined,
      })}
      // No consent banner either: there is nothing to consent to on a page that loads nothing.
      consentAnswered
      current="home"
    >
      <PreviewClickGuard />
      {context.sections.some((section) => section.type === 'hero') ? null : (
        <h1 className="sf-vh">{context.site.name || t('dashboard', 'appearance.title')}</h1>
      )}
      <SectionList context={context} sections={context.sections} />
    </StorefrontShell>
  );
}
