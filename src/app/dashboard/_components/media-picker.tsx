import { formatNumber, t } from '@/shared/i18n';
import type { MediaStatus } from '@/server/media';
import { Tag } from './ui';

/**
 * Choose a photo from the library.
 *
 * This is the component `docs/PHASE-9.md` calls "one component unblocks six features", and it is
 * worth stating what it replaces: nothing. `Site.logoMediaId`, `Site.faviconMediaId`,
 * `Site.ogImageMediaId`, `hero.imageMediaId` and `gallery.mediaIds` were all reachable only from the
 * super admin's panel or a demo pack, and `settings/page.tsx` carried the logo through a HIDDEN
 * INPUT purely so an ordinary save would not blank it.
 *
 * WHY `<details>` AND NOT A DIALOG. A modal picker is the reflex, and here it costs more than it
 * buys. This dashboard has no client-side form state anywhere — every screen is a plain `<form>`
 * posting to a server action (`ActionForm`) — so a dialog would be the first stateful widget on the
 * surface, and it would need focus trapping, an escape handler, scroll locking, an inert background
 * and a return-focus path, every one of which is a way to fail axe. A `<details>` disclosure is
 * keyboard-operable, screen-reader-announced and focus-correct in every browser without a line of
 * JavaScript, and it keeps the inputs INSIDE the form, which is the property that actually matters:
 * the chosen id posts with the rest of the fields instead of having to be shuttled into a hidden
 * input by a script. The cost is that the library is inline rather than overlaid. On a screen whose
 * job is "pick one of the twenty photos this shop owns", that is not a cost.
 *
 * WHAT IT DOES NOT DO, deliberately:
 *   - no storage. Nothing here writes `localStorage` or `sessionStorage`: the only state is the
 *     checked input, which the browser already owns and the server already validated;
 *   - no search and no infinite scroll. Paging would have to be a link, a link is a navigation, and
 *     a navigation in the middle of an unsaved form loses the merchant's other fields. The picker
 *     shows the most recent `items` the page handed it and links to the full library for the rest;
 *   - no upload. Uploading goes to `/api/media/upload` through `MediaUploader`, because that handler
 *     reads the body through a counting reader that stops at the plan ceiling BEFORE buffering. A
 *     second upload path here would be a second place for the limits to be wrong. The branding and
 *     banner screens render the uploader beside the picker instead.
 */

export interface MediaPickerItem {
  id: string;
  status: MediaStatus;
  /** The card-sized WebP from A3's pipeline, or null while the item is not ready. */
  previewUrl: string | null;
  altText: string | null;
  originalName: string | null;
}

export interface MediaPickerProps {
  /** The form field name. The checked input IS the field — there is no separate hidden input. */
  name: string;
  items: MediaPickerItem[];
  /** Already-translated Arabic, the way `Field` takes it. */
  label: string;
  hint?: string;
  /** `gallery.mediaIds` — checkboxes instead of radios, and `form.getAll(name)` on the other side. */
  multiple?: boolean;
  selectedIds?: string[];
  /**
   * Offer «بدون صورة». Single-select only, and ON by default: without it a merchant who set a logo
   * once can never remove it, because a radio group has no way back to "none".
   */
  allowNone?: boolean;
}

/** Only a processed item can be chosen — the storefront reads `status: 'ready'` and nothing else. */
function isChoosable(item: MediaPickerItem): boolean {
  return item.status === 'ready';
}

function hasAlt(item: MediaPickerItem): boolean {
  return (item.altText ?? '').trim().length > 0;
}

/** What a merchant reads in the list: their own description, or the file they uploaded. */
function itemName(item: MediaPickerItem): string {
  return (item.altText ?? '').trim() || (item.originalName ?? '').trim() || t('content', 'picker.untitled');
}

export function MediaPicker({
  name,
  items,
  label,
  hint,
  multiple = false,
  selectedIds = [],
  allowNone = true,
}: MediaPickerProps) {
  const selected = new Set(selectedIds.filter((id) => id !== ''));
  const chosen = items.filter((item) => selected.has(item.id));

  /**
   * A selected id that is not in `items` still counts.
   *
   * The page hands over a recent slice of the library, so a logo set two hundred photos ago is
   * selected and absent — and rendering the summary from `chosen.length` alone would tell that
   * merchant they have no logo, one click before they overwrite it with nothing.
   */
  const missingFromList = selected.size - chosen.length;

  const summary = multiple
    ? t('content', 'picker.selectedCount', { count: formatNumber(selected.size) })
    : chosen[0]
      ? itemName(chosen[0])
      : missingFromList > 0
        ? t('content', 'picker.selectedElsewhere')
        : t('content', 'picker.none');

  const preview = chosen[0]?.previewUrl ?? null;

  /**
   * Missing alt text is SURFACED, not hidden (invariant 4).
   *
   * The temptation is to filter these out of the list so a merchant cannot pick one — which would
   * quietly hide half their library and give them no way to find out why. The photo is offered, the
   * gap is named, and the fix is one link away on the media screen where alt text is edited.
   */
  const altGaps = chosen.filter((item) => !hasAlt(item)).length;

  return (
    <fieldset className="sbd-field sbd-picker">
      <legend className="sbd-label">{label}</legend>
      {hint ? <span className="sbd-hint">{hint}</span> : null}

      {/*
        The current choice is visible with the disclosure CLOSED. That is the whole reason the
        summary carries a thumbnail: a merchant opening the branding screen has to be able to see
        which photo is their logo without opening anything, exactly as the hidden input in
        settings/page.tsx made impossible.
      */}
      <details className="sbd-picker__panel">
        <summary className="sbd-picker__summary">
          {preview ? (
            /* A CDN variant — see media-image.tsx for why next/image is refused everywhere. */
            // eslint-disable-next-line @next/next/no-img-element
            <img
              className="sbd-thumb"
              src={preview}
              /* Decorative: the visible text beside it already names the photo, and repeating the
                 description would make a screen reader say it twice. */
              alt=""
              width={80}
              height={80}
            />
          ) : null}
          <span>{summary}</span>
        </summary>

        {altGaps > 0 ? (
          <p className="sbd-notice sbd-notice--warn" role="status">
            {t('content', 'picker.altMissing')} <a href="/media">{t('content', 'picker.manage')}</a>
          </p>
        ) : null}

        {items.length === 0 ? (
          <p className="sbd-empty">{t('content', 'picker.empty')}</p>
        ) : (
          <ul className="sbd-picker__grid">
            {allowNone && !multiple ? (
              <li>
                <label className="sbd-picker__option" htmlFor={`${name}-none`}>
                  <input
                    id={`${name}-none`}
                    type="radio"
                    name={name}
                    value=""
                    defaultChecked={selected.size === 0}
                  />
                  <span className="sbd-picker__label">{t('content', 'picker.none')}</span>
                </label>
              </li>
            ) : null}

            {items.map((item) => {
              const choosable = isChoosable(item);
              const inputId = `${name}-${item.id}`;

              return (
                <li key={item.id}>
                  <label className="sbd-picker__option" htmlFor={inputId}>
                    <input
                      id={inputId}
                      type={multiple ? 'checkbox' : 'radio'}
                      name={name}
                      value={item.id}
                      defaultChecked={selected.has(item.id)}
                      /*
                        DISABLED, not omitted. A photo uploaded ninety seconds ago is «قيد المعالجة»
                        and will be usable shortly; leaving it out of the grid makes a merchant
                        think the upload failed and do it again, which is how a storage quota gets
                        spent twice. The service re-checks `status: 'ready'` regardless — a disabled
                        input is a courtesy, not a boundary.
                      */
                      disabled={!choosable}
                    />
                    {item.previewUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        className="sbd-thumb"
                        src={item.previewUrl}
                        alt=""
                        width={120}
                        height={120}
                        loading="lazy"
                      />
                    ) : (
                      <span className="sbd-picker__blank" aria-hidden="true" />
                    )}

                    <span className="sbd-picker__label">
                      <span>{itemName(item)}</span>
                      {choosable ? null : (
                        <Tag label={t('media', `status.${item.status}`)} tone="muted" />
                      )}
                      {choosable && !hasAlt(item) ? (
                        <Tag label={t('content', 'picker.noAlt')} tone="muted" />
                      ) : null}
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        )}

        <p className="sbd-hint">
          {t('content', 'picker.showing', { count: formatNumber(items.length) })}{' '}
          {/*
            A plain `<a>`, not `next/link`, and both reasons are real. Prefetch: this link sits inside
            a `<details>` that is closed on arrival and, on the branding screen, appears three times —
            `Link` would prefetch the media library on every page view for a link most merchants never
            follow, on a route that is `force-dynamic` anyway so there is nothing worth prefetching.
            And it keeps this component renderable by a unit test with no Next router in scope, which
            is what lets the picker's disabled/alt-gap states be asserted rather than reviewed.
            `globals.css` styles `a` with the platform accent, so it looks like the link it is.
          */}
          <a href="/media">{t('content', 'picker.manage')}</a>
        </p>
      </details>
    </fieldset>
  );
}
