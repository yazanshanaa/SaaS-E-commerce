import { notFound } from 'next/navigation';
import { MAX_TOWNS_PER_ZONE, type ZoneView } from '@/server/delivery';
import { formatAgorot, formatNumber, t } from '@/shared/i18n';
import { param } from '../_components/guard';
import { isExhausted, quotaLine } from '../_components/locked-field';
import { noticeKey } from '../_components/messages';
import { Empty, Notice, PageHead, Panel, Tag } from '../_components/ui';
import {
  deleteZoneAction,
  requestPolicyChangeAction,
  requestZoneChangeAction,
  requestZoneDeleteAction,
  savePolicyAction,
  saveZoneAction,
  seedZonesAction,
} from './actions';
import {
  loadDeliveryEditor,
  requireDeliveryContext,
  testTownMatch,
  type DeliveryEditorView,
  type TesterResult,
} from './data';

/**
 * «مناطق التوصيل» — the merchant's zone table, its four switches, and the town-match tester.
 *
 * BOTH ACCESS AXES, shown rather than smoothed over (see `data.ts`): the FEATURE decides whether
 * this screen exists at all, and the CAPABILITY decides whether a submit writes to the database or
 * lands in the change-request queue. When it is the queue, the fields stay editable — copied from
 * `ColorEditor` and `size-guide/page.tsx` deliberately, and for their stated reason: a table the
 * merchant cannot type into is a change request they cannot describe. What makes it read-only in the
 * sense that matters is that nothing they type reaches the database until an operator applies it.
 *
 * NO JAVASCRIPT ANYWHERE ON THIS SCREEN. Every zone is its own plain `<form>` posting to a server
 * action, and the tester is a `method="get"` form whose answer is computed server-side. A zone table
 * is edited on a phone in a shop with two bars of signal.
 */
export const dynamic = 'force-dynamic';

export default async function DeliveryPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = await requireDeliveryContext();
  const view = await loadDeliveryEditor(ctx);
  // The FEATURE, not the capability: a plan without zone pricing has no such screen.
  if (!view) notFound();

  const query = await searchParams;
  const townQuery = param(query, 'town') ?? '';
  const tester = await testTownMatch(ctx, townQuery, view.policy);

  const locked = !view.editable;
  const exhausted = isExhausted(view.quota);

  return (
    <>
      <PageHead
        title={t('delivery', 'zones.title')}
        subtitle={t('delivery', 'zones.subtitle')}
        actions={
          <Tag
            label={
              view.coverage.zoneCount === 0
                ? t('delivery', 'zones.coverageEmpty')
                : t('delivery', 'zones.coverage', {
                    zones: formatNumber(view.coverage.zoneCount),
                    towns: formatNumber(view.coverage.townCount),
                  })
            }
            tone={view.coverage.zoneCount === 0 ? 'muted' : 'ok'}
          />
        }
      />

      <Notice
        okKey={noticeKey('delivery', param(query, 'ok'))}
        // The actions emit a bare code, and TWO shapes of it: a `notices.*` name, or the `errors.*` /
        // `tax.errors.*` path a zod schema already named. The passthrough list is what keeps those
        // schema-authored sentences reachable instead of collapsing to «صار خطأ غير متوقع»; everything
        // else is prefixed, so a crafted `?error=` cannot name a message outside this catalogue.
        errorKey={noticeKey('delivery', param(query, 'error'), ['errors.', 'tax.errors.'])}
        // The `{town}`/`{zone}` placeholders of `notices.townClaimed`. Read from their own
        // parameter names so the tester's `?town=` cannot be mistaken for an error echo.
        params={{
          town: param(query, 'claimedTown') ?? '',
          zone: param(query, 'claimedZone') ?? '',
        }}
      />

      {param(query, 'ok') === 'seeded' ? <SeedReportPanel query={query} /> : null}

      {locked ? (
        <Panel tone="locked" actions={<Tag label={t('delivery', 'locked.cta')} tone="locked" />}>
          <div className="sbd-notice sbd-notice--info">
            <p>{t('delivery', 'locked.notice')}</p>
            <p className="sbd-hint">{quotaLine(view.quota)}</p>
            {view.openRequests > 0 ? (
              <p className="sbd-hint">{t('dashboard', 'lockedField.pending')}</p>
            ) : null}
          </div>
        </Panel>
      ) : null}

      <PolicyPanel view={view} locked={locked} exhausted={exhausted} />

      <TesterPanel view={view} townQuery={townQuery} tester={tester} />

      <Panel title={t('delivery', 'zones.listTitle')} note={t('delivery', 'zones.matchNote')}>
        <p className="sbd-hint">{t('delivery', 'zones.oneZonePerTown')}</p>

        {view.zones.length === 0 ? (
          <Empty>{t('delivery', 'zones.empty')}</Empty>
        ) : (
          <div className="sbd-grid">
            {view.zones.map((zone) => (
              <ZoneForm
                key={zone.id}
                zone={zone}
                locked={locked}
                exhausted={exhausted}
              />
            ))}
          </div>
        )}
      </Panel>

      <Panel title={t('delivery', 'zones.newTitle')}>
        <ZoneForm locked={locked} exhausted={exhausted} />
      </Panel>

      {view.carriersFeatureOn ? <CarriersPanel view={view} locked={locked} /> : null}
    </>
  );
}

// -----------------------------------------------------------------------------
// The four switches
// -----------------------------------------------------------------------------

function PolicyPanel({
  view,
  locked,
  exhausted,
}: {
  view: DeliveryEditorView;
  locked: boolean;
  exhausted: boolean;
}) {
  return (
    <Panel
      title={t('delivery', 'policy.title')}
      note={t('delivery', 'policy.subtitle')}
      tone={locked ? 'locked' : undefined}
    >
      <form
        action={locked ? requestPolicyChangeAction : savePolicyAction}
        className="sbd-form"
      >
        <label className="sbd-check" htmlFor="zonePricingEnabled">
          <input
            id="zonePricingEnabled"
            type="checkbox"
            name="zonePricingEnabled"
            defaultChecked={view.policy.zonePricingEnabled}
          />
          <span>
            {t('delivery', 'policy.zonePricingEnabled')}
            <span className="sbd-hint">{t('delivery', 'policy.zonePricingHint')}</span>
          </span>
        </label>

        <div className="sbd-row">
          <div className="sbd-field">
            <label className="sbd-label" htmlFor="unlistedTownFeeAgorot">
              {t('delivery', 'policy.unlistedTownFee')}
            </label>
            <input
              className="sbd-input"
              id="unlistedTownFeeAgorot"
              name="unlistedTownFeeAgorot"
              type="number"
              min="0"
              step="1"
              inputMode="numeric"
              defaultValue={view.policy.unlistedTownFeeAgorot ?? ''}
            />
            <span className="sbd-hint">{t('delivery', 'policy.unlistedTownFeeHint')}</span>
          </div>

          <div className="sbd-field">
            <label className="sbd-label" htmlFor="codFeeAgorot">
              {t('delivery', 'policy.codFee')}
            </label>
            <input
              className="sbd-input"
              id="codFeeAgorot"
              name="codFeeAgorot"
              type="number"
              min="0"
              step="1"
              inputMode="numeric"
              defaultValue={view.policy.codFeeAgorot}
            />
            <span className="sbd-hint">{t('delivery', 'policy.codFeeHint')}</span>
          </div>

          <div className="sbd-field">
            <label className="sbd-label" htmlFor="codMaxAgorot">
              {t('delivery', 'policy.codMax')}
            </label>
            <input
              className="sbd-input"
              id="codMaxAgorot"
              name="codMaxAgorot"
              type="number"
              min="0"
              step="1"
              inputMode="numeric"
              defaultValue={view.policy.codMaxAgorot ?? ''}
            />
            <span className="sbd-hint">{t('delivery', 'policy.codMaxHint')}</span>
          </div>
        </div>

        <p className="sbd-hint">{t('delivery', 'policy.agorotHint')}</p>

        {locked ? <LockedNote idSuffix="-policy" /> : null}

        <button type="submit" className="sbd-btn sbd-btn--primary" disabled={locked && exhausted}>
          {locked ? t('delivery', 'locked.cta') : t('delivery', 'policy.save')}
        </button>
      </form>
    </Panel>
  );
}

// -----------------------------------------------------------------------------
// The tester
// -----------------------------------------------------------------------------

function TesterPanel({
  view,
  townQuery,
  tester,
}: {
  view: DeliveryEditorView;
  townQuery: string;
  tester: TesterResult;
}) {
  return (
    <Panel title={t('delivery', 'tester.title')} note={t('delivery', 'tester.subtitle')}>
      {/*
        `method="get"`, no action attribute: the form submits to the current URL and the answer is
        rendered by this same server component. A POST server action would have to redirect to carry
        its answer back — a round trip and a query string for a function that mutates nothing.
      */}
      <form method="get" className="sbd-form">
        <div className="sbd-field">
          <label className="sbd-label" htmlFor="town">
            {t('delivery', 'tester.field')}
          </label>
          <input
            className="sbd-input"
            id="town"
            name="town"
            defaultValue={townQuery}
            placeholder={t('delivery', 'tester.placeholder')}
            autoComplete="off"
          />
        </div>
        <button type="submit" className="sbd-btn">
          {t('delivery', 'tester.cta')}
        </button>
      </form>

      {!view.policy.zonePricingEnabled ? (
        <p className="sbd-hint">{t('delivery', 'tester.zonePricingOff')}</p>
      ) : null}

      <TesterAnswer tester={tester} />
    </Panel>
  );
}

function TesterAnswer({ tester }: { tester: TesterResult }) {
  if (tester.kind === 'empty') {
    return <p className="sbd-hint">{t('delivery', 'tester.empty')}</p>;
  }

  if (tester.kind === 'unmatchable') {
    return (
      <div className="sbd-notice sbd-notice--warn" role="status">
        {t('delivery', 'tester.unmatchable')}
      </div>
    );
  }

  return (
    <div
      className={tester.kind === 'not_served' ? 'sbd-notice sbd-notice--warn' : 'sbd-notice sbd-notice--info'}
      role="status"
    >
      <p>
        {tester.kind === 'matched'
          ? tester.match.enabled
            ? t('delivery', 'tester.matched', {
                zone: tester.match.zoneName,
                fee: formatAgorot(tester.match.feeAgorot),
              })
            : t('delivery', 'tester.matchedDisabled', { zone: tester.match.zoneName })
          : tester.kind === 'unlisted'
            ? t('delivery', 'tester.unlisted', { fee: formatAgorot(tester.feeAgorot) })
            : t('delivery', 'tester.notServed')}
      </p>

      {tester.kind === 'matched' && tester.match.etaLabel ? (
        <p className="sbd-hint">{t('delivery', 'tester.eta', { eta: tester.match.etaLabel })}</p>
      ) : null}

      {/*
        The normalised key is shown DELIBERATELY, and only here. `DeliveryZoneTown.normalised` says
        "never displayed", which means never on a storefront — this is the one screen whose entire
        job is explaining why two different spellings reach the same row, and hiding the key would
        make the tester a black box that the merchant has to take on trust.
      */}
      <p className="sbd-hint">{t('delivery', 'tester.key', { key: tester.normalised })}</p>
      <p className="sbd-hint">{t('delivery', 'tester.keyHint')}</p>
    </div>
  );
}

// -----------------------------------------------------------------------------
// One zone
// -----------------------------------------------------------------------------

function ZoneForm({
  zone,
  locked,
  exhausted,
}: {
  zone?: ZoneView;
  locked: boolean;
  exhausted: boolean;
}) {
  // Suffixed so every `<label for>` on a page with five of these points at its own input. Without
  // it, clicking a label focuses the first zone's field — an accessibility bug that only appears
  // once there is real data.
  const suffix = zone ? `-${zone.id}` : '-new';

  return (
    // A card per EXISTING zone, so five of them read as a list. The add-zone form already sits
    // inside its own panel, and a card inside a card is two borders saying one thing.
    <div className={zone ? 'sbd-panel' : undefined}>
      <form action={locked ? requestZoneChangeAction : saveZoneAction} className="sbd-form">
        {zone ? <input type="hidden" name="zoneId" value={zone.id} /> : null}

        <div className="sbd-row">
          <div className="sbd-field">
            <label className="sbd-label" htmlFor={`name${suffix}`}>
              {t('delivery', 'zones.fields.name')}
            </label>
            <input
              className="sbd-input"
              id={`name${suffix}`}
              name="name"
              defaultValue={zone?.name ?? ''}
              required
            />
            <span className="sbd-hint">{t('delivery', 'zones.fields.nameHint')}</span>
          </div>

          <div className="sbd-field">
            <label className="sbd-label" htmlFor={`feeAgorot${suffix}`}>
              {t('delivery', 'zones.fields.fee')}
            </label>
            <input
              className="sbd-input"
              id={`feeAgorot${suffix}`}
              name="feeAgorot"
              type="number"
              min="0"
              step="1"
              inputMode="numeric"
              defaultValue={zone?.feeAgorot ?? 0}
              required
            />
            <span className="sbd-hint">{t('delivery', 'zones.fields.feeHint')}</span>
          </div>

          <div className="sbd-field">
            <label className="sbd-label" htmlFor={`etaLabel${suffix}`}>
              {t('delivery', 'zones.fields.eta')}
            </label>
            <input
              className="sbd-input"
              id={`etaLabel${suffix}`}
              name="etaLabel"
              defaultValue={zone?.etaLabel ?? ''}
            />
            <span className="sbd-hint">{t('delivery', 'zones.fields.etaHint')}</span>
          </div>

          <div className="sbd-field">
            <label className="sbd-label" htmlFor={`sort${suffix}`}>
              {t('delivery', 'zones.fields.sort')}
            </label>
            <input
              className="sbd-input"
              id={`sort${suffix}`}
              name="sort"
              type="number"
              min="0"
              max="999"
              step="1"
              defaultValue={zone?.sort ?? 0}
            />
          </div>
        </div>

        <label className="sbd-check" htmlFor={`enabled${suffix}`}>
          <input
            id={`enabled${suffix}`}
            type="checkbox"
            name="enabled"
            defaultChecked={zone?.enabled ?? true}
          />
          <span>
            {t('delivery', 'zones.fields.enabled')}
            <span className="sbd-hint">{t('delivery', 'zones.fields.enabledHint')}</span>
          </span>
        </label>

        <div className="sbd-field">
          <label className="sbd-label" htmlFor={`townsText${suffix}`}>
            {t('delivery', 'zones.fields.towns')}
          </label>
          <textarea
            className="sbd-textarea"
            id={`townsText${suffix}`}
            name="townsText"
            rows={8}
            defaultValue={(zone?.towns ?? []).map((town) => town.name).join('\n')}
          />
          <span className="sbd-hint">
            {t('delivery', 'zones.fields.townsHint', { max: formatNumber(MAX_TOWNS_PER_ZONE) })}
          </span>
          {zone ? (
            <span className="sbd-hint">
              {t('delivery', 'zones.fields.townCount', { count: formatNumber(zone.towns.length) })}
              {zone.seededFromCarrierId ? ` · ${t('delivery', 'zones.seededFrom')}` : ''}
            </span>
          ) : null}
        </div>

        {locked ? <LockedNote idSuffix={suffix} /> : null}

        <button type="submit" className="sbd-btn sbd-btn--primary" disabled={locked && exhausted}>
          {locked
            ? t('delivery', 'locked.cta')
            : zone
              ? t('delivery', 'zones.save')
              : t('delivery', 'zones.add')}
        </button>
      </form>

      {/*
        A SIBLING form, never nested: a `<form>` inside a `<form>` is invalid HTML and browsers drop
        the inner one silently, so this button would have submitted the save action instead.
      */}
      {zone ? (
        <form
          action={locked ? requestZoneDeleteAction : deleteZoneAction}
          className="sbd-actions"
        >
          <input type="hidden" name="zoneId" value={zone.id} />
          <button
            type="submit"
            className="sbd-btn sbd-btn--danger sbd-btn--sm"
            disabled={locked && exhausted}
          >
            {locked ? t('delivery', 'locked.requestDelete') : t('delivery', 'zones.delete')}
          </button>
          <span className="sbd-hint">{t('delivery', 'zones.deleteHint')}</span>
        </form>
      ) : null}
    </div>
  );
}

/** The «ملاحظة للإدارة» box, shown only on the locked path — an operator reads it before applying. */
function LockedNote({ idSuffix }: { idSuffix: string }) {
  return (
    <div className="sbd-field">
      <label className="sbd-label" htmlFor={`note${idSuffix}`}>
        {t('delivery', 'locked.note')}
      </label>
      <textarea className="sbd-textarea" id={`note${idSuffix}`} name="note" rows={2} />
      <span className="sbd-hint">{t('delivery', 'locked.noteHint')}</span>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Carriers and the one-click copy
// -----------------------------------------------------------------------------

function CarriersPanel({ view, locked }: { view: DeliveryEditorView; locked: boolean }) {
  return (
    <Panel title={t('delivery', 'assigned.title')} note={t('delivery', 'assigned.subtitle')}>
      {view.carriers.length === 0 ? (
        <Empty>{t('delivery', 'seed.empty')}</Empty>
      ) : (
        <div className="sbd-grid">
          {view.carriers.map((carrier) => (
            <div className="sbd-panel" key={carrier.carrierId}>
              <h3 className="sbd-panel-title">{carrier.name}</h3>
              <p className="sbd-hint">
                {t('delivery', 'assigned.rateCount', { count: formatNumber(carrier.rateCount) })}
                {carrier.reference
                  ? ` · ${t('delivery', 'assigned.reference', { reference: carrier.reference })}`
                  : ''}
              </p>
              {!carrier.enabled ? <Tag label={t('delivery', 'assigned.disabled')} tone="muted" /> : null}

              {/*
                Hidden while the capability is locked: the copy is a WRITE to the zone table, and
                offering a button that would be refused is worse than not offering it. A locked
                merchant asks for the zones they want through the same «اطلب تعديل» as everything
                else on the screen.
              */}
              {locked || carrier.rateCount === 0 ? (
                <p className="sbd-hint">
                  {carrier.rateCount === 0
                    ? t('delivery', 'seed.noRates')
                    : t('delivery', 'locked.notice')}
                </p>
              ) : (
                <form action={seedZonesAction} className="sbd-actions">
                  <input type="hidden" name="carrierId" value={carrier.carrierId} />
                  <button type="submit" className="sbd-btn sbd-btn--sm">
                    {t('delivery', 'seed.cta')}
                  </button>
                </form>
              )}
            </div>
          ))}
        </div>
      )}

      <p className="sbd-hint">{t('delivery', 'seed.subtitle')}</p>
      <p className="sbd-hint">{t('delivery', 'seed.safeNote')}</p>
    </Panel>
  );
}

/**
 * What the seed actually did.
 *
 * Read out of the query string the action redirected to, and composed HERE through `t()` — the
 * action passes counts and capped name lists, never a sentence, so the copy stays in
 * `messages/ar/delivery.json` where the language gate can see it.
 */
function SeedReportPanel({
  query,
}: {
  query: Record<string, string | string[] | undefined>;
}) {
  const carrier = param(query, 'carrier') ?? '';
  const added = Number(param(query, 'added') ?? '0');
  const skippedZones = Number(param(query, 'skippedZones') ?? '0');
  const skippedTowns = Number(param(query, 'skippedTowns') ?? '0');

  return (
    <Panel title={t('delivery', 'seed.report.title', { carrier })}>
      <p>
        {added > 0
          ? t('delivery', 'seed.report.added', { count: formatNumber(added) })
          : t('delivery', 'seed.report.addedNone')}
      </p>

      {skippedZones > 0 ? (
        <p className="sbd-hint">
          {t('delivery', 'seed.report.skippedZones', {
            count: formatNumber(skippedZones),
            names: param(query, 'skippedZoneNames') ?? '',
          })}
        </p>
      ) : null}

      {skippedTowns > 0 ? (
        <p className="sbd-hint">
          {t('delivery', 'seed.report.skippedTowns', {
            count: formatNumber(skippedTowns),
            names: param(query, 'skippedTownNames') ?? '',
          })}
        </p>
      ) : null}

      {param(query, 'truncated') === '1' ? (
        <p className="sbd-hint">{t('delivery', 'seed.report.truncated')}</p>
      ) : null}
    </Panel>
  );
}
