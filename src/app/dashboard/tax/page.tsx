import { notFound } from 'next/navigation';
import { VAT_BASIS_POINTS_MAX, vatPercentLabel } from '@/server/tax';
import { t } from '@/shared/i18n';
import { param } from '../_components/guard';
import { isExhausted, quotaLine } from '../_components/locked-field';
import { noticeKey } from '../_components/messages';
import { Notice, PageHead, Panel, Tag } from '../_components/ui';
import { requestTaxChangeAction, saveTaxAction } from './actions';
import { loadTaxEditor, requireTaxContext } from './data';

/**
 * «الفواتير والضريبة».
 *
 * TWO NOTICES ARE THE POINT OF THIS SCREEN, and neither is decoration:
 *
 *   1. «ما في هون مكان لمفتاح ربط» — the credentials note. This model holds no secret by design
 *      (invariant 7), and a merchant who cannot find the API-key box will paste their key into
 *      «مزوّد الفواتير» unless told plainly why there isn't one.
 *   2. «راجع النسبة مع محاسبك» — the platform states no rate and asserts no threshold. A statutory
 *      rate changes by ministerial order, and a hint that named today's number would be confidently
 *      wrong on the day it changed. The number in the field is whatever the merchant put there.
 *
 * The rate is entered in BASIS POINTS and the current value is echoed back as a percentage right
 * under the field, so «1750» and «17.5%» are visible in the same glance. That echo is the fastest
 * way for a merchant to notice they typed the wrong unit — the schema refuses anything under 1% with
 * a sentence, but a value like `175` is legal (1.75%) and only the echo catches it.
 */
export const dynamic = 'force-dynamic';

export default async function TaxPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = await requireTaxContext();
  const view = await loadTaxEditor(ctx);
  // The FEATURE, not the capability: a plan without invoicing settings has no such screen.
  if (!view) notFound();

  const query = await searchParams;
  const locked = !view.editable;
  const exhausted = isExhausted(view.quota);

  return (
    <>
      <PageHead title={t('delivery', 'tax.title')} subtitle={t('delivery', 'tax.subtitle')} />

      {/* Still the `delivery` catalogue: the tax panel's copy lives there, next to the screens it
          shares a track with. `tax.errors.*` is a group inside it, hence the passthrough. */}
      <Notice
        okKey={noticeKey('delivery', param(query, 'ok'))}
        errorKey={noticeKey('delivery', param(query, 'error'), ['errors.', 'tax.errors.'])}
      />

      <Panel
        tone={locked ? 'locked' : undefined}
        actions={locked ? <Tag label={t('delivery', 'locked.cta')} tone="locked" /> : undefined}
      >
        {locked ? (
          <div className="sbd-notice sbd-notice--info">
            <p>{t('delivery', 'tax.locked')}</p>
            <p className="sbd-hint">{quotaLine(view.quota)}</p>
            {view.openRequests > 0 ? (
              <p className="sbd-hint">{t('dashboard', 'lockedField.pending')}</p>
            ) : null}
          </div>
        ) : null}

        {/* Both notices sit ABOVE the fields, where they are read before anything is typed. */}
        <div className="sbd-notice sbd-notice--warn" role="note">
          {t('delivery', 'tax.credentialsNote')}
        </div>
        <p className="sbd-hint">{t('delivery', 'tax.accountantNote')}</p>

        <form action={locked ? requestTaxChangeAction : saveTaxAction} className="sbd-form">
          <div className="sbd-row">
            <div className="sbd-field">
              <label className="sbd-label" htmlFor="legalName">
                {t('delivery', 'tax.fields.legalName')}
              </label>
              <input
                className="sbd-input"
                id="legalName"
                name="legalName"
                defaultValue={view.settings.legalName ?? ''}
              />
              <span className="sbd-hint">{t('delivery', 'tax.fields.legalNameHint')}</span>
            </div>

            <div className="sbd-field">
              <label className="sbd-label" htmlFor="businessNumber">
                {t('delivery', 'tax.fields.businessNumber')}
              </label>
              <input
                className="sbd-input"
                id="businessNumber"
                name="businessNumber"
                inputMode="numeric"
                defaultValue={view.settings.businessNumber ?? ''}
              />
              <span className="sbd-hint">{t('delivery', 'tax.fields.businessNumberHint')}</span>
            </div>
          </div>

          <div className="sbd-field">
            <label className="sbd-label" htmlFor="vatRateBasisPoints">
              {t('delivery', 'tax.fields.vatRate')}
            </label>
            <input
              className="sbd-input"
              id="vatRateBasisPoints"
              name="vatRateBasisPoints"
              type="number"
              min="0"
              max={String(VAT_BASIS_POINTS_MAX)}
              step="1"
              inputMode="numeric"
              defaultValue={view.settings.vatRateBasisPoints ?? ''}
            />
            <span className="sbd-hint">{t('delivery', 'tax.fields.vatRateHint')}</span>
            <span className="sbd-hint">
              {view.settings.vatRateBasisPoints === null
                ? t('delivery', 'tax.fields.vatRateEmpty')
                : t('delivery', 'tax.fields.vatRateCurrent', {
                    rate: vatPercentLabel(view.settings.vatRateBasisPoints),
                  })}
            </span>
          </div>

          <label className="sbd-check" htmlFor="pricesIncludeVat">
            <input
              id="pricesIncludeVat"
              type="checkbox"
              name="pricesIncludeVat"
              defaultChecked={view.settings.pricesIncludeVat}
            />
            <span>
              {t('delivery', 'tax.fields.pricesIncludeVat')}
              <span className="sbd-hint">{t('delivery', 'tax.fields.pricesIncludeVatHint')}</span>
            </span>
          </label>

          <div className="sbd-field">
            <label className="sbd-label" htmlFor="invoiceProvider">
              {t('delivery', 'tax.fields.invoiceProvider')}
            </label>
            <input
              className="sbd-input"
              id="invoiceProvider"
              name="invoiceProvider"
              defaultValue={view.settings.invoiceProvider ?? ''}
            />
            <span className="sbd-hint">{t('delivery', 'tax.fields.invoiceProviderHint')}</span>
          </div>

          {locked ? (
            <div className="sbd-field">
              <label className="sbd-label" htmlFor="note">
                {t('delivery', 'locked.note')}
              </label>
              <textarea className="sbd-textarea" id="note" name="note" rows={2} />
              <span className="sbd-hint">{t('delivery', 'locked.noteHint')}</span>
            </div>
          ) : null}

          {/*
            At zero remaining the button is DISABLED and the notice above explains why — a submit
            that silently fails would be worse than one that cannot be pressed
            (`appearance/page.tsx`).
          */}
          <button type="submit" className="sbd-btn sbd-btn--primary" disabled={locked && exhausted}>
            {locked ? t('delivery', 'locked.cta') : t('delivery', 'tax.save')}
          </button>
        </form>
      </Panel>
    </>
  );
}
