import { notFound } from 'next/navigation';
import { MAX_TOWNS_PER_ZONE, getCarrier, type CarrierRateRow } from '@/server/delivery';
import { formatAgorot, formatNumber, t } from '@/shared/i18n';
import { param, requireAdminPage } from '../../_components/guard';
import { noticeKey } from '../../_components/messages';
import {
  BackLink,
  Checkbox,
  Empty,
  Field,
  Notice,
  PageHead,
  Panel,
  TextInput,
} from '../../_components/ui';
import {
  deleteCarrierAction,
  deleteCarrierRateAction,
  saveCarrierRateAction,
  updateCarrierAction,
} from '../actions';

/**
 * One carrier: its own fields, and its rate card.
 *
 * THE RATE CARD IS THE THING THAT MATTERS on this screen — it is what a merchant copies into their
 * own zone table in one click, so a wrong price here becomes a wrong price on some shop's checkout
 * next week. Each rate is therefore shown in full, including the towns it covers, rather than as a
 * count with an edit link: an operator who cannot see the town list cannot notice that «عرعرة» is
 * missing from it.
 *
 * Each rate's edit form lives inside a `<details>`, closed by default. That keeps a fifteen-row
 * card readable while still needing no JavaScript at all — the same reason `/admin/audit` shows a
 * payload that way.
 */
export const dynamic = 'force-dynamic';

export default async function CarrierDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ carrierId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { carrierId } = await params;
  const ctx = await requireAdminPage();
  const query = await searchParams;

  const carrier = await getCarrier(ctx, carrierId);
  if (!carrier) notFound();

  return (
    <>
      <PageHead
        title={carrier.name}
        subtitle={t('delivery', 'carriers.assign.rateCount', { count: formatNumber(carrier.rateCount) })}
        actions={<BackLink href="/carriers" label={t('common', 'actions.back')} />}
      />

      <Notice
        okKey={noticeKey('delivery', param(query, 'ok'))}
        errorKey={noticeKey('delivery', param(query, 'error'))}
      />

      <Panel title={t('delivery', 'carriers.editTitle')}>
        <form action={updateCarrierAction} className="sba-form">
          <input type="hidden" name="carrierId" value={carrier.id} />
          {/*
            The key is posted back unchanged and `saveCarrier` never writes it on update. It is
            shown read-only rather than hidden so an operator can copy it into a seed file, which is
            the only reason anyone ever needs to see it.
          */}
          <Field
            label={t('delivery', 'carriers.fields.key')}
            name="key"
            hint={t('delivery', 'carriers.fields.keyHint')}
          >
            <TextInput name="key" defaultValue={carrier.key} />
          </Field>

          <Field
            label={t('delivery', 'carriers.fields.name')}
            name="name"
            hint={t('delivery', 'carriers.fields.nameHint')}
          >
            <TextInput name="name" defaultValue={carrier.name} required />
          </Field>

          <div className="sba-row">
            <Field label={t('delivery', 'carriers.fields.phone')} name="phone">
              <TextInput name="phone" type="tel" defaultValue={carrier.phone ?? ''} />
            </Field>
            <Field label={t('delivery', 'carriers.fields.website')} name="website">
              <TextInput name="website" type="url" defaultValue={carrier.website ?? ''} />
            </Field>
            <Field label={t('delivery', 'carriers.fields.sort')} name="sort">
              <TextInput name="sort" type="number" min="0" max="999" step="1" defaultValue={carrier.sort} />
            </Field>
          </div>

          <Field
            label={t('delivery', 'carriers.fields.notes')}
            name="notes"
            hint={t('delivery', 'carriers.fields.notesHint')}
          >
            <textarea
              className="sba-textarea"
              id="notes"
              name="notes"
              rows={3}
              defaultValue={carrier.notes ?? ''}
            />
          </Field>

          <Checkbox
            name="hidden"
            label={t('delivery', 'carriers.fields.hidden')}
            hint={t('delivery', 'carriers.fields.hiddenHint')}
            defaultChecked={carrier.hidden}
          />

          <button type="submit" className="sba-btn sba-btn--primary">
            {t('common', 'actions.save')}
          </button>
        </form>
      </Panel>

      <Panel title={t('delivery', 'carriers.rates.title')} note={t('delivery', 'carriers.rates.subtitle')}>
        {carrier.rates.length === 0 ? (
          <Empty>{t('delivery', 'carriers.rates.empty')}</Empty>
        ) : (
          <div className="sba-stack">
            {carrier.rates.map((rate) => (
              <RateItem key={rate.id} carrierId={carrier.id} rate={rate} />
            ))}
          </div>
        )}
      </Panel>

      <Panel title={t('delivery', 'carriers.rates.add')}>
        <RateForm carrierId={carrier.id} submitLabel={t('delivery', 'carriers.rates.add')} />
      </Panel>

      <Panel title={t('delivery', 'carriers.delete.title')} tone="danger">
        <p className="sba-panel-note">{t('delivery', 'carriers.delete.hint')}</p>
        <form action={deleteCarrierAction}>
          <input type="hidden" name="carrierId" value={carrier.id} />
          {/*
            Disabled when shops depend on it. The server refuses regardless (`deleteCarrier` checks
            the count AND catches the foreign-key refusal), so this is the explanation rather than
            the enforcement.
          */}
          <button
            type="submit"
            className="sba-btn sba-btn--danger"
            disabled={carrier.assignmentCount > 0}
          >
            {t('delivery', 'carriers.delete.cta')}
          </button>
        </form>
      </Panel>
    </>
  );
}

function RateItem({ carrierId, rate }: { carrierId: string; rate: CarrierRateRow }) {
  return (
    <div className="sba-item">
      <div className="sba-item-head">
        <strong>{rate.zoneName}</strong>
        <span className="sba-num">{formatAgorot(rate.feeAgorot)}</span>
        <span className="sba-chip">
          {t('delivery', 'carriers.rates.townCount', { count: formatNumber(rate.towns.length) })}
        </span>
        {rate.etaLabel ? <span className="sba-chip">{rate.etaLabel}</span> : null}
      </div>

      <details className="sba-details">
        <summary>{t('common', 'actions.edit')}</summary>
        <RateForm carrierId={carrierId} rate={rate} submitLabel={t('common', 'actions.save')} />

        {/*
          A SIBLING of the edit form, never nested inside it. A `<form>` inside a `<form>` is
          invalid HTML and browsers silently drop the inner one — the delete button would then
          submit the edit action with no `rateId`, which is a create.
        */}
        <form action={deleteCarrierRateAction} className="sba-actions">
          <input type="hidden" name="carrierId" value={carrierId} />
          <input type="hidden" name="rateId" value={rate.id} />
          <button type="submit" className="sba-btn sba-btn--danger sba-btn--sm">
            {t('delivery', 'carriers.rates.delete')}
          </button>
        </form>
      </details>
    </div>
  );
}

/**
 * One rate, add or edit.
 *
 * `id` is suffixed per rate so every `<label for>` on a page with fifteen of these still points at
 * its own input — without it, clicking a label would focus the first rate's field, which is the
 * kind of accessibility bug that only shows up with real data.
 */
function RateForm({
  carrierId,
  rate,
  submitLabel,
}: {
  carrierId: string;
  rate?: CarrierRateRow;
  submitLabel: string;
}) {
  const suffix = rate ? `-${rate.id}` : '-new';

  return (
    <form action={saveCarrierRateAction} className="sba-form">
      <input type="hidden" name="carrierId" value={carrierId} />
      {rate ? <input type="hidden" name="rateId" value={rate.id} /> : null}

      <div className="sba-row">
        <div className="sba-field">
          <label className="sba-label" htmlFor={`zoneName${suffix}`}>
            {t('delivery', 'carriers.rates.zoneName')}
          </label>
          <input
            className="sba-input"
            id={`zoneName${suffix}`}
            name="zoneName"
            defaultValue={rate?.zoneName ?? ''}
            required
          />
        </div>

        <div className="sba-field">
          <label className="sba-label" htmlFor={`feeAgorot${suffix}`}>
            {t('delivery', 'carriers.rates.fee')}
          </label>
          <input
            className="sba-input"
            id={`feeAgorot${suffix}`}
            name="feeAgorot"
            type="number"
            min="0"
            step="1"
            defaultValue={rate?.feeAgorot ?? 0}
            required
          />
          <span className="sba-hint">{t('delivery', 'carriers.rates.feeHint')}</span>
        </div>

        <div className="sba-field">
          <label className="sba-label" htmlFor={`etaLabel${suffix}`}>
            {t('delivery', 'carriers.rates.eta')}
          </label>
          <input
            className="sba-input"
            id={`etaLabel${suffix}`}
            name="etaLabel"
            defaultValue={rate?.etaLabel ?? ''}
          />
          <span className="sba-hint">{t('delivery', 'carriers.rates.etaHint')}</span>
        </div>

        <div className="sba-field">
          <label className="sba-label" htmlFor={`sort${suffix}`}>
            {t('delivery', 'carriers.rates.sort')}
          </label>
          <input
            className="sba-input"
            id={`sort${suffix}`}
            name="sort"
            type="number"
            min="0"
            max="999"
            step="1"
            defaultValue={rate?.sort ?? 0}
          />
        </div>
      </div>

      <div className="sba-field">
        <label className="sba-label" htmlFor={`townsText${suffix}`}>
          {t('delivery', 'carriers.rates.towns')}
        </label>
        <textarea
          className="sba-textarea"
          id={`townsText${suffix}`}
          name="townsText"
          rows={6}
          defaultValue={(rate?.towns ?? []).join('\n')}
        />
        <span className="sba-hint">
          {t('delivery', 'carriers.rates.townsHint', { max: formatNumber(MAX_TOWNS_PER_ZONE) })}
        </span>
      </div>

      <div className="sba-actions">
        <button type="submit" className="sba-btn sba-btn--sm">
          {submitLabel}
        </button>
      </div>
    </form>
  );
}
