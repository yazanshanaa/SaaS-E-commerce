import { notFound } from 'next/navigation';
import Link from 'next/link';
import { formatNumber, t } from '@/shared/i18n';
import { loadSizeGuideEditor } from '../../_lib/size-guide';
import { loadCapabilityContext } from '../../_lib/change-requests';
import { param, requireMerchantPage } from '../../_components/guard';
import { ActionForm } from '../../_components/action-form';
import { CapabilityTag, LockedNotice, isExhausted } from '../../_components/locked-field';
import { BackLink, Field, Notice, PageHead, Panel, TextArea, TextInput } from '../../_components/ui';
import { saveSizeGuideAction } from '../actions';

/**
 * «جدول المقاسات» — the one Track A screen that sits on BOTH access axes, and it shows the
 * difference rather than smoothing it over.
 *
 *   axis (a) `size_guide` FEATURE off      -> this route 404s. Absent, not disabled
 *                                            (`settings/advanced/page.tsx`'s criterion).
 *   axis (b) `size_guide` CAPABILITY admin -> the editor still renders, filled in, with the change
 *                                            request attached to the same submit. Copied from
 *                                            `appearance/page.tsx`, including the reason: the
 *                                            merchant fills in what they want and asks for it in
 *                                            one gesture instead of describing a table in a text
 *                                            box.
 *
 * NOTE WHAT "READ-ONLY" DOES AND DOES NOT MEAN HERE. The locked state does NOT set `readOnly` on the
 * inputs, and that is copied from `ColorEditor`'s behaviour rather than from the sentence next to it:
 * a chart the merchant cannot type into is a change request they cannot describe, so the fields stay
 * editable and it is the SUBMIT that changes destination. What makes it read-only in the sense that
 * matters is that nothing they type reaches the database until an operator applies it.
 *
 * ONE FORM FOR THE WHOLE CHART. A table is edited as a table — the save is replace-all within the
 * scope (`saveSizeGuide`), so a row removed from the form is a row deleted, and per-row saves would
 * have made "remove the L row" impossible to express without a second control.
 */
export const dynamic = 'force-dynamic';

/** How many blank rows to offer below the ones that exist, so adding a size needs no second visit. */
const SPARE_ROWS = 3;

/**
 * The Arabic comma is a DELIMITER here, not copy: `parseColumns` and `parseCellList` both accept it
 * alongside the Latin comma and a newline, so what the merchant reads back is what they typed.
 * Named once so the writer and the reader cannot drift.
 */
const LIST_SEPARATOR = '، ';

export default async function SizeGuidePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = await requireMerchantPage('products');
  const params = await searchParams;

  const scope = param(params, 'categoryId') ?? '';
  const [view, capabilityContext] = await Promise.all([
    loadSizeGuideEditor(ctx, scope === '' ? null : scope),
    loadCapabilityContext(ctx),
  ]);

  // The FEATURE, not the capability: a plan without a size guide has no such screen.
  if (!view) notFound();

  const capability = capabilityContext.capabilities.size_guide;
  const locked = !capability.editable;
  const exhausted = isExhausted(capabilityContext.quota);

  const rows = [
    ...view.entries,
    ...Array.from({ length: SPARE_ROWS }, (_, index) => ({
      id: `blank-${index}`,
      label: '',
      cells: [] as string[],
      sort: view.entries.length + index,
      categoryId: null,
    })),
  ].slice(0, view.maxEntries + SPARE_ROWS);

  return (
    <>
      <PageHead
        title={t('catalogue', 'sizeGuide.title')}
        subtitle={t('catalogue', 'sizeGuide.subtitle')}
        actions={<BackLink href="/products" label={t('common', 'actions.back')} />}
      />

      <Notice okKey={param(params, 'ok')} errorKey={param(params, 'error')} />

      {/*
        The scope picker is a row of LINKS, not a select inside the form.

        Switching scope has to RELOAD the chart, and a select cannot do that without JavaScript —
        which this dashboard does not use for form state anywhere. Links also make each chart a URL
        the merchant can bookmark, and the counts tell them at a glance which departments already
        have one.
      */}
      <Panel title={t('catalogue', 'sizeGuide.scope')} note={t('catalogue', 'sizeGuide.scopeHint')}>
        <nav className="sbd-actions" aria-label={t('catalogue', 'sizeGuide.scope')}>
          <Link
            className="sbd-btn sbd-btn--sm"
            href="/products/size-guide"
            aria-current={scope === '' ? 'page' : undefined}
          >
            {t('catalogue', 'sizeGuide.scopeAll')}
          </Link>
          {view.categories.map((category) => (
            <Link
              key={category.id}
              className="sbd-btn sbd-btn--sm"
              href={`/products/size-guide?categoryId=${encodeURIComponent(category.id)}`}
              aria-current={scope === category.id ? 'page' : undefined}
            >
              {category.name}
              <span className="sbd-num">{formatNumber(category.entryCount)}</span>
            </Link>
          ))}
        </nav>
      </Panel>

      <Panel
        title={t('catalogue', 'sizeGuide.title')}
        tone={locked ? 'locked' : undefined}
        actions={<CapabilityTag capability={capability} />}
      >
        {locked ? <LockedNotice capability={capability} quota={capabilityContext.quota} /> : null}

        <ActionForm
          action={saveSizeGuideAction}
          submitLabel={locked ? t('dashboard', 'lockedField.cta') : t('common', 'actions.save')}
          // At zero remaining the button is DISABLED and the notice above explains the ₪25 add-on.
          // A submit that silently fails would be worse than one that cannot be pressed.
          disabled={locked && exhausted}
        >
          <input type="hidden" name="categoryId" value={scope} />

          <Field
            label={t('catalogue', 'sizeGuide.columns')}
            name="columns"
            hint={t('catalogue', 'sizeGuide.columnsHint', {
              max: formatNumber(view.maxColumns),
            })}
          >
            {/*
              The headers are SITE-LEVEL and are written even when this form is scoped to one
              category — `saveSizeGuide`'s contract, and the reason they sit above the scope picker's
              result rather than inside each chart: two charts on one site disagreeing about what
              the third number means is the failure a size guide exists to prevent.
            */}
            <TextInput name="columns" defaultValue={view.columns.join(LIST_SEPARATOR)} />
          </Field>

          <Field
            label={t('catalogue', 'sizeGuide.note')}
            name="note"
            hint={t('catalogue', 'sizeGuide.noteHint')}
          >
            <TextArea name="note" defaultValue={view.note ?? ''} rows={2} />
          </Field>

          <p className="sbd-hint">{t('catalogue', 'sizeGuide.entryCellsHint')}</p>

          {rows.map((row) => (
            <div className="sbd-grid" key={row.id}>
              <Field label={t('catalogue', 'sizeGuide.entryLabel')} name={`label-${row.id}`}>
                {/*
                  `entryLabel` and `entryCells` are PARALLEL repeated fields, zipped by index in
                  `sizeGuideFromForm`. A row whose label is blank is dropped there — which is how a
                  spare row costs nothing and how deleting a size is just clearing its label.
                */}
                <TextInput
                  id={`label-${row.id}`}
                  name="entryLabel"
                  defaultValue={row.label}
                 
                />
              </Field>

              <Field label={t('catalogue', 'sizeGuide.entryCells')} name={`cells-${row.id}`}>
                <TextInput
                  id={`cells-${row.id}`}
                  name="entryCells"
                  defaultValue={row.cells.join(LIST_SEPARATOR)}
                 
                />
              </Field>
            </div>
          ))}

          {locked ? (
            <Field
              /* `name` must match the input's id, which `TextArea` derives from ITS name — a
                 mismatch here is a `<label for>` pointing at nothing, which is exactly the kind of
                 thing that passes review and fails axe. */
              label={t('dashboard', 'lockedField.note')}
              name="requestNote"
              hint={t('dashboard', 'lockedField.noteHint')}
            >
              {/*
                The request note is `note` on the wire, which is also the chart's own footer note —
                and that collision would silently file the merchant's message to the platform as
                the sentence under their size table. So the request note posts under a DIFFERENT
                name and `saveSizeGuideAction` reads it as such.
              */}
              <TextArea name="requestNote" rows={3} />
            </Field>
          ) : null}
        </ActionForm>
      </Panel>

      <Panel title={t('catalogue', 'sizeGuide.entries')}>
        {view.entries.length === 0 ? (
          <p className="sbd-empty">{t('catalogue', 'sizeGuide.empty')}</p>
        ) : (
          <div className="sbd-table-scroll">
            <table className="sbd-table">
              <caption className="sbd-hint">{t('catalogue', 'sizeGuide.caption')}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('catalogue', 'sizeGuide.sizeColumn')}</th>
                  {view.columns.map((column, index) => (
                    <th scope="col" key={`${column}-${index}`}>
                      {column}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {view.entries.map((entry) => (
                  <tr key={entry.id}>
                    <th scope="row">{entry.label}</th>
                    {/* Iterating the COLUMNS, not the cells — see `components/size-guide.tsx`. */}
                    {view.columns.map((column, index) => (
                      <td key={`${entry.id}-${column}-${index}`}>{entry.cells[index] ?? ''}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

    </>
  );
}
