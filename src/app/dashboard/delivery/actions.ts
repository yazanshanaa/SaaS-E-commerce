'use server';

import { redirect } from 'next/navigation';
import {
  deliveryPolicySchema,
  listZones,
  parseTownList,
  zoneInputSchema,
  zoneTableFrom,
  type SeedReport,
} from '@/server/delivery';
import { checkbox, text } from '../_lib/validation';
import {
  deleteZoneForMerchant,
  proposeZoneTable,
  requestDeliveryChange,
  requireDeliveryContext,
  savePolicyForMerchant,
  saveZoneForMerchant,
  seedForMerchant,
  validationCode,
} from './data';

/**
 * The zone editor's writes.
 *
 * REDIRECT STYLE, like `orders/settings/actions.ts` and for its stated reason: the form re-renders
 * from the freshly saved rows either way, and a locked field must not appear to have accepted an
 * edit it silently discarded. It is also the only style that can carry the seed REPORT back — a
 * `useActionState` banner would hold one sentence, and the report is «أضفنا ٣، تخطّينا ٢، وهاي
 * أسماءها».
 *
 * `?error=` carries a CODE, never a sentence and never a namespaced key — and that stays true now that
 * `_components/messages.ts` knows the `delivery` namespace. The reason is no longer the allow-list: a
 * bare code cannot name an arbitrary message in an arbitrary catalogue, and the value arrives in a URL
 * a crafted link controls. The page prefixes it with `noticeKey('delivery', …)`. Two shapes are
 * allowed — a `notices.*` name, or the `errors.*` / `tax.errors.*` path a zod schema already named, so
 * the specific sentences those schemas were written to produce actually reach the merchant.
 */

/** Bounded so a hand-edited query string cannot paste a paragraph into the merchant's banner. */
const MAX_ECHO = 80;

function query(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === '') continue;
    search.set(key, String(value).slice(0, 240));
  }
  const rendered = search.toString();
  return rendered === '' ? '' : `?${rendered}`;
}

function back(params: Record<string, string | number | undefined>): never {
  redirect(`/delivery${query(params)}`);
}

function integer(form: FormData, name: string): number {
  const value = Number(text(form, name).trim());
  return Number.isInteger(value) ? value : 0;
}

/** An empty box is «ما في» — a different answer from zero, and the whole point of both nullables. */
function optionalInteger(form: FormData, name: string): number | null {
  const raw = text(form, name).trim();
  if (raw === '') return null;
  const value = Number(raw);
  return Number.isInteger(value) ? value : null;
}

/**
 * One submitted zone form into a validated `ZoneInput`.
 *
 * The towns arrive as ONE textarea rather than as repeated fields, because that is what a merchant
 * pastes: a column copied out of a spreadsheet, or a list a courier sent on واتساب. `parseTownList`
 * owns the separators and the de-duplication; this function owns nothing but the shape.
 */
function readZone(form: FormData) {
  return zoneInputSchema.safeParse({
    id: text(form, 'zoneId') || undefined,
    name: text(form, 'name'),
    feeAgorot: integer(form, 'feeAgorot'),
    etaLabel: text(form, 'etaLabel'),
    enabled: checkbox(form, 'enabled'),
    sort: integer(form, 'sort'),
    towns: parseTownList(text(form, 'townsText')).towns.map((town) => town.name),
  });
}

function readPolicy(form: FormData) {
  return deliveryPolicySchema.safeParse({
    zonePricingEnabled: checkbox(form, 'zonePricingEnabled'),
    unlistedTownFeeAgorot: optionalInteger(form, 'unlistedTownFeeAgorot'),
    codFeeAgorot: integer(form, 'codFeeAgorot'),
    codMaxAgorot: optionalInteger(form, 'codMaxAgorot'),
  });
}

// -----------------------------------------------------------------------------
// Direct path — the merchant may edit
// -----------------------------------------------------------------------------

export async function saveZoneAction(form: FormData): Promise<void> {
  const ctx = await requireDeliveryContext();

  const parsed = readZone(form);
  if (!parsed.success) back({ error: validationCode(parsed.error) });

  const result = await saveZoneForMerchant(ctx, parsed.data);
  if (result.ok) back({ ok: 'zoneSaved' });

  // The one refusal that has to name names: "this town is taken" without saying by which zone
  // sends the merchant hunting through four hundred lines.
  if (result.error === 'town_claimed') {
    // NOT `town`/`zone`: the tester's own GET form owns `?town=`, and reusing it here would make
    // an error banner silently re-run the tester with the offending name.
    back({
      error: 'townClaimed',
      claimedTown: result.townName.slice(0, MAX_ECHO),
      claimedZone: result.zoneName.slice(0, MAX_ECHO),
    });
  }

  back({ error: ZONE_ERRORS[result.error] });
}

const ZONE_ERRORS = {
  forbidden: 'forbidden',
  not_found: 'notFound',
  name_taken: 'zoneNameTaken',
  too_many_zones: 'tooManyZones',
  too_many_towns: 'tooManyTowns',
} as const;

export async function deleteZoneAction(form: FormData): Promise<void> {
  const ctx = await requireDeliveryContext();

  const result = await deleteZoneForMerchant(ctx, text(form, 'zoneId'));
  back(result.ok ? { ok: 'zoneDeleted' } : { error: ZONE_ERRORS[result.error] });
}

export async function savePolicyAction(form: FormData): Promise<void> {
  const ctx = await requireDeliveryContext();

  const parsed = readPolicy(form);
  if (!parsed.success) back({ error: validationCode(parsed.error) });

  const result = await savePolicyForMerchant(ctx, parsed.data);
  back(result.ok ? { ok: 'policySaved' } : { error: 'forbidden' });
}

/**
 * The one-click copy from an assigned carrier.
 *
 * The report travels back as STRUCTURED PARAMETERS and not as a sentence, so the page composes it
 * through `t()` like every other string on the surface. Names are capped and counted separately —
 * a merchant with a hundred and ninety-five skipped towns needs the number and a taste, not a URL
 * with all of them in it.
 */
export async function seedZonesAction(form: FormData): Promise<void> {
  const ctx = await requireDeliveryContext();

  const result = await seedForMerchant(ctx, text(form, 'carrierId'));

  if (!result.ok) {
    const code =
      result.error === 'carrier_not_assigned'
        ? 'carrierNotAssigned'
        : result.error === 'no_rates'
          ? 'seedNoRates'
          : result.error === 'zone_limit_reached'
            ? 'tooManyZones'
            : 'forbidden';
    back({ error: code });
  }

  back({ ok: 'seeded', ...reportParams(result.report) });
}

function reportParams(report: SeedReport): Record<string, string | number> {
  return {
    carrier: report.carrierName.slice(0, MAX_ECHO),
    added: report.added.length,
    skippedZones: report.skippedZones.length,
    skippedZoneNames: joinCapped(report.skippedZones),
    skippedTowns: report.skippedTowns.length,
    skippedTownNames: joinCapped(report.skippedTowns.map((town) => town.townName)),
    truncated: report.truncated ? '1' : '',
  };
}

/** The Arabic comma is a DELIMITER here, not copy — same call `parseTownList` makes on the way in. */
function joinCapped(names: readonly string[]): string {
  const joined = names.join('، ');
  return joined.length <= 120 ? joined : `${joined.slice(0, 120)}…`;
}

// -----------------------------------------------------------------------------
// Locked path — the platform owner edits, the merchant asks
// -----------------------------------------------------------------------------

/**
 * Every locked submit carries THE WHOLE TABLE, not the one row that changed.
 *
 * The current rows are re-read here rather than round-tripped through hidden inputs: a merchant with
 * five zones and a hundred and ninety-five towns would otherwise post forty kilobytes of form on
 * every request, and a stale tab would propose a table that no longer exists.
 */
export async function requestZoneChangeAction(form: FormData): Promise<void> {
  const ctx = await requireDeliveryContext();

  const parsed = readZone(form);
  if (!parsed.success) back({ error: validationCode(parsed.error) });

  const zoneId = text(form, 'zoneId') || null;
  const zones = await listZones(ctx.db, ctx.tenantId);
  // `id` is dropped: `applyZoneTable` matches by NAME, and a payload carrying ids from a table the
  // operator may rebuild before approving would be a payload pointing at rows that are gone.
  const { id: _id, ...zone } = parsed.data;

  const proposal = proposeZoneTable(zones, { zoneId, zone });
  const result = await requestDeliveryChange(ctx, proposal, text(form, 'note'));

  back(result.ok ? { ok: 'changeRequested' } : { error: 'forbidden' });
}

export async function requestZoneDeleteAction(form: FormData): Promise<void> {
  const ctx = await requireDeliveryContext();

  const zones = await listZones(ctx.db, ctx.tenantId);
  const proposal = proposeZoneTable(zones, { zoneId: text(form, 'zoneId'), zone: null });
  const result = await requestDeliveryChange(ctx, proposal, text(form, 'note'));

  back(result.ok ? { ok: 'changeRequested' } : { error: 'forbidden' });
}

export async function requestPolicyChangeAction(form: FormData): Promise<void> {
  const ctx = await requireDeliveryContext();

  const parsed = readPolicy(form);
  if (!parsed.success) back({ error: validationCode(parsed.error) });

  const zones = await listZones(ctx.db, ctx.tenantId);
  const result = await requestDeliveryChange(
    ctx,
    { ...zoneTableFrom(zones), policy: parsed.data },
    text(form, 'note'),
  );

  back(result.ok ? { ok: 'changeRequested' } : { error: 'forbidden' });
}
