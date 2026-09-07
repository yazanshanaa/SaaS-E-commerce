import Link from 'next/link';
import { can } from '@/server/entitlements';
import { formatDate, formatNumber, t } from '@/shared/i18n';
import { mapLinkFor } from '@/shared/map-url';
import { getSiteDetails, listAnnouncements, listSocialLinks, socialPlatformSchema } from '../_lib/site';
import { loadCapabilityContext, listOwnChangeRequests } from '../_lib/change-requests';
import { loadAdvanced } from '../_lib/settings';
import { merchantCan } from '../_lib/context';
import { canSelfServeExport } from '../_lib/export';
import { param, requireMerchantPage } from '../_components/guard';
import { ActionForm } from '../_components/action-form';
import { CapabilityTag, LockedNotice, isExhausted } from '../_components/locked-field';
import {
  Checkbox,
  Empty,
  Field,
  Notice,
  PageHead,
  Panel,
  Tag,
  TextArea,
  TextInput,
} from '../_components/ui';
import {
  deleteAnnouncementAction,
  saveAnnouncementAction,
  saveAnnouncementBarAction,
  saveDetailsAction,
  saveMapAction,
  saveSocialAction,
} from './actions';

/**
 * The shop's details, and the four managed capabilities that live beside them.
 *
 * Business details are always the merchant's — name, tagline, about, address, phones, WhatsApp,
 * hours are the shop's identity, not appearance. The four below them each render open or locked
 * depending on `editable_by`, and a locked panel is visibly different rather than merely
 * disabled: the whole of access axis (b) should be legible at a glance.
 *
 * `settings` is an OWNER scope. A staff member cannot reach this URL — the guard 404s before
 * anything is read.
 */
export const dynamic = 'force-dynamic';

function toDateInput(value: Date | null): string {
  return value ? value.toISOString().slice(0, 10) : '';
}

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = await requireMerchantPage('settings');
  const params = await searchParams;

  const [
    site,
    social,
    announcements,
    capabilityContext,
    requests,
    hasExport,
    hasDomain,
    advanced,
    searchFeature,
  ] = await Promise.all([
      getSiteDetails(ctx),
      listSocialLinks(ctx),
      listAnnouncements(ctx),
      loadCapabilityContext(ctx),
      listOwnChangeRequests(ctx, 10),
      /**
       * The EXPORT link is gated on `canSelfServeExport`, not on the `export` scope.
       *
       * `checkMerchantAccess` deliberately leaves `export` un-feature-gated, because the
       * SUSPENSION export runs on every plan (Q18) and must never consult a flag. So the scope
       * is true for any owner, and using it here showed a basic-plan merchant a link to a page
       * that 404s — an invitation to discover a feature they do not have by bouncing off it.
       */
      canSelfServeExport(ctx),
      merchantCan(ctx, 'domain'),
      /**
       * The ADVANCED link is gated on "does this plan include anything advanced", not on
       * `custom_domain`.
       *
       * It used to reuse the domain scope, which was accidentally correct while the domain panel
       * lived on that screen and every plan with `pwa` also had `custom_domain`. Neither is true
       * now: Phase 4 moved domains to their own screen, so a tenant with `pwa` or `seo_tools` and
       * no custom domain — an ordinary per-tenant entitlement override away — lost the only link
       * to the two panels they DO have, on a page that renders them perfectly.
       */
      loadAdvanced(ctx),
      /**
       * The PLAN half of `flags.search` — the same question `src/app/site/_data/context.ts` asks
       * when it decides whether the storefront draws a search box at all, so the «فعّل البحث»
       * checkbox is offered exactly when flipping it would change something.
       *
       * In the `Promise.all`, not awaited after it: this screen already makes eight round trips and
       * a ninth in series is a ninth in series.
       */
      can(ctx.tenantId, 'search_insights'),
    ]);

  if (!site) return <Empty>{t('common', 'states.empty')}</Empty>;

  const hasSearchFeature = searchFeature === true;

  const hasAdvanced = advanced !== null && !advanced.flags.empty;

  const { capabilities, quota } = capabilityContext;
  const exhausted = isExhausted(quota);
  const socialByPlatform = new Map(social.map((link) => [link.platform, link]));

  /** One shape for every managed panel: locked or not, and what the submit means. */
  const panel = (key: keyof typeof capabilities) => {
    const capability = capabilities[key];
    return {
      capability,
      locked: !capability.editable,
      tone: capability.editable ? undefined : ('locked' as const),
      submitLabel: capability.editable
        ? t('common', 'actions.save')
        : t('dashboard', 'lockedField.cta'),
      disabled: !capability.editable && exhausted,
    };
  };

  /** Rebuilt from the stored pair, for the "check the pin" link under the map panel. */
  const storedMapLink = mapLinkFor(site.mapLat, site.mapLng);

  const socialPanel = panel('social_links');
  const mapPanel = panel('map_location');
  const barPanel = panel('announcement_bar');
  const boardPanel = panel('announcements_board');

  return (
    <>
      <PageHead
        title={t('dashboard', 'settings.title')}
        subtitle={t('dashboard', 'settings.subtitle')}
        actions={
          <>
            {hasAdvanced ? (
              <Link className="sbd-btn" href="/settings/advanced">
                {t('dashboard', 'advanced.title')}
              </Link>
            ) : null}
            {/*
              A DIRECT link to the domain screen, beside the advanced one rather than only inside
              it. Connecting a domain is a job a merchant comes to the dashboard specifically to
              do, usually once, often with a registrar's control panel already open in another
              tab — burying it one click deeper than "إعدادات متقدمة" is how a merchant ends up
              phoning to ask where it is.
            */}
            {hasDomain ? (
              <Link className="sbd-btn" href="/settings/domain">
                {t('dashboard', 'domain.title')}
              </Link>
            ) : null}
            {hasExport ? (
              <Link className="sbd-btn" href="/settings/export">
                {t('dashboard', 'export.title')}
              </Link>
            ) : null}
          </>
        }
      />

      <Notice okKey={param(params, 'ok')} errorKey={param(params, 'error')} />

      <Panel title={t('dashboard', 'settings.details')}>
        <ActionForm action={saveDetailsAction} submitLabel={t('dashboard', 'actions.saveChanges')}>
          <div className="sbd-grid">
            <Field label={t('dashboard', 'settings.fields.name')} name="name">
              <TextInput name="name" defaultValue={site.name} required />
            </Field>
            <Field label={t('dashboard', 'settings.fields.tagline')} name="tagline">
              <TextInput name="tagline" defaultValue={site.tagline ?? ''} />
            </Field>
          </div>

          <Field label={t('dashboard', 'settings.fields.about')} name="about">
            <TextArea name="about" defaultValue={site.about ?? ''} rows={5} />
          </Field>

          <div className="sbd-grid">
            <Field label={t('dashboard', 'settings.fields.address')} name="address">
              <TextInput name="address" defaultValue={site.address ?? ''} />
            </Field>
            <Field label={t('dashboard', 'settings.fields.phone')} name="phone">
              <TextInput name="phone" defaultValue={site.phone ?? ''} inputMode="tel" />
            </Field>
            <Field
              label={t('dashboard', 'settings.fields.whatsapp')}
              name="whatsapp"
              hint={t('dashboard', 'settings.fields.whatsappHint')}
            >
              <TextInput name="whatsapp" defaultValue={site.whatsapp ?? ''} inputMode="tel" />
            </Field>
            <Field label={t('dashboard', 'settings.fields.email')} name="email">
              <TextInput name="email" defaultValue={site.email ?? ''} inputMode="email" />
            </Field>
          </div>

          {/*
            THE OPENING-HOURS TEXTAREA IS GONE (2026-09-06, owner-directed).

            The platform stored the same fact twice: a free-text box here, and the seven-day picker
            on `/content/hours` that writes real `OpeningHours` rows. Two editors for one fact is a
            fact that is wrong in one of them — and it was reliably this one, because the textarea is
            what a merchant fills in on setup day and never opens again, while the picker is what the
            «ساعات الدوام» section and the «مفتوح الآن» pill are computed from.

            The picker is now the ONLY editor and the storefront prefers it everywhere
            (`templates/lib/hours-summary.ts`). `hours` posts as a hidden field carrying the stored
            value so this form does not blank the legacy sentence some accounts still rely on as a
            fallback — `saveDetails` reads the field, and an absent input would parse as "clear it".
          */}
          <input type="hidden" name="hours" value={site.hours ?? ''} />

          {/*
            A `div`, not a `Field`. `Field` renders `<label htmlFor={name}>`, and a label pointing at
            something that is not a form control is a broken association — it is announced, focuses
            nothing, and fails the same axe rule an unlabelled input does. There is no control here
            to label: this is a signpost.
          */}
          <div className="sbd-field">
            <span className="sbd-label">{t('dashboard', 'settings.fields.hours')}</span>
            <p className="sbd-hint">{t('dashboard', 'settings.fields.hoursMoved')}</p>
            <p>
              <Link className="sbd-btn" href="/content/hours">
                {t('dashboard', 'settings.fields.hoursCta')}
              </Link>
            </p>
          </div>

          {/*
            «فعّل البحث» — the switch that never existed (2026-09-06, owner-directed).

            `Site.searchEnabled` has been a column since Phase 9 and defaults to false, and nothing
            in the product could set it: no merchant screen, no admin screen, no seed. So the search
            box, the `/search` route and the zero-result report that `search_insights` sells were
            unreachable on every account. This is the missing half.

            It is rendered only when the PLAN half is also true. A checkbox for a feature the shop
            does not have would be a switch that changes nothing — and it would advertise a feature
            to a merchant who cannot use it, which this codebase refuses everywhere else.
          */}
          {hasSearchFeature ? (
            <Checkbox
              name="searchEnabled"
              label={t('dashboard', 'settings.fields.searchEnabled')}
              defaultChecked={site.searchEnabled}
            />
          ) : (
            <input type="hidden" name="searchEnabled" value={site.searchEnabled ? 'on' : ''} />
          )}
          {hasSearchFeature ? (
            <p className="sbd-hint">{t('dashboard', 'settings.fields.searchEnabledHint')}</p>
          ) : null}

          {/*
            The logo used to be carried through here as a hidden field, because it is a media id
            and there was no picker anywhere in the product to choose one with. There is now: the
            logo, the tab icon and the share image live on `/content/branding`, behind the
            `logo_upload` feature and the `logo` capability. Nothing on this form touches them, so
            there is nothing to carry through.

            The hidden input and `logoMediaId` in `detailsSchema` were removed together, and had to
            be: that field is `.nullable().default(null)`, so an absent input would have parsed as
            an explicit null and blanked the shop's logo on the first save of its own name.
          */}
        </ActionForm>
      </Panel>

      <Panel
        title={t('dashboard', 'settings.social')}
        note={t('dashboard', 'settings.socialHint')}
        tone={socialPanel.tone}
        actions={<CapabilityTag capability={socialPanel.capability} />}
      >
        {socialPanel.locked ? (
          <LockedNotice capability={socialPanel.capability} quota={quota} />
        ) : null}

        <ActionForm
          action={saveSocialAction}
          submitLabel={socialPanel.submitLabel}
          disabled={socialPanel.disabled}
        >
          <div className="sbd-grid">
            {socialPlatformSchema.options.map((platform) => {
              const link = socialByPlatform.get(platform);
              return (
                <Field
                  key={platform}
                  label={t('dashboard', `settings.platforms.${platform}`)}
                  name={`url-${platform}`}
                >
                  <TextInput
                    name={`url-${platform}`}
                    defaultValue={link?.url ?? ''}
                    readOnly={socialPanel.locked}
                    inputMode="url"
                  />
                  <input
                    type="hidden"
                    name={`enabled-${platform}`}
                    value={link?.enabled === false ? '' : 'on'}
                  />
                </Field>
              );
            })}
          </div>

          {socialPanel.locked ? <NoteField /> : null}
        </ActionForm>
      </Panel>

      <Panel
        title={t('dashboard', 'settings.map')}
        note={t('dashboard', 'settings.mapHint')}
        tone={mapPanel.tone}
        actions={<CapabilityTag capability={mapPanel.capability} />}
      >
        {mapPanel.locked ? <LockedNotice capability={mapPanel.capability} quota={quota} /> : null}

        <ActionForm
          action={saveMapAction}
          submitLabel={mapPanel.submitLabel}
          disabled={mapPanel.disabled}
        >
          {/*
            ONE LINK BOX, NOT TWO DECIMAL BOXES (2026-09-06, owner-directed).

            «خط العرض» and «خط الطول» asked a shop owner for two numbers they have no way of knowing.
            What they DO have is what «مشاركة» in Google Maps or Waze puts on their clipboard, and
            every one of those links carries the pair inside it — `parseMapLink` in
            `src/shared/map-url.ts` extracts it in the action. The COLUMNS are unchanged, so the
            storefront, the Waze deep link and the change-request payload all still see coordinates.

            The box is pre-filled with a link REBUILT from the stored pair rather than left blank on
            a shop that has a location, so «احفظ» on an untouched form is not a silent delete.
          */}
          <Field
            label={t('dashboard', 'settings.mapLink')}
            name="mapLink"
            hint={t('dashboard', 'settings.mapLinkHint')}
          >
            <TextInput
              name="mapLink"
              defaultValue={storedMapLink ?? ''}
              readOnly={mapPanel.locked}
              inputMode="url"
              dir="ltr"
            />
          </Field>

          <Field
            label={t('dashboard', 'settings.mapQuery')}
            name="mapQuery"
            hint={t('dashboard', 'settings.mapQueryHint')}
          >
            <TextInput
              name="mapQuery"
              defaultValue={site.mapQuery ?? ''}
              readOnly={mapPanel.locked}
            />
          </Field>

          {mapPanel.locked ? <NoteField /> : null}
        </ActionForm>

        {/*
          A CHECK LINK for what is currently stored. Confirming the pin lands on the right shop is
          the only way a merchant can tell a correct save from a plausible-looking one, and it costs
          nothing to offer — the same button the operator's screen already had.
        */}
        {storedMapLink ? (
          <p className="sbd-hint" style={{ marginBlockStart: 'var(--sb-space-4)' }}>
            <a href={storedMapLink} target="_blank" rel="noreferrer noopener">
              {t('dashboard', 'settings.mapCheck')}
            </a>
          </p>
        ) : null}
      </Panel>

      <Panel
        title={t('dashboard', 'settings.announcementBar')}
        note={t('dashboard', 'settings.announcementBarHint')}
        tone={barPanel.tone}
        actions={<CapabilityTag capability={barPanel.capability} />}
      >
        {barPanel.locked ? <LockedNotice capability={barPanel.capability} quota={quota} /> : null}

        <ActionForm
          action={saveAnnouncementBarAction}
          submitLabel={barPanel.submitLabel}
          disabled={barPanel.disabled}
        >
          <Checkbox
            name="enabled"
            label={t('dashboard', 'settings.announcementBarEnabled')}
            defaultChecked={site.announcementBarEnabled}
            disabled={barPanel.locked}
          />

          <Field label={t('dashboard', 'settings.announcementBarText')} name="text">
            <TextInput
              name="text"
              defaultValue={site.announcementBarText ?? ''}
              readOnly={barPanel.locked}
            />
          </Field>

          <div className="sbd-grid">
            <Field label={t('dashboard', 'settings.announcementBarLink')} name="link">
              <TextInput
                name="link"
                defaultValue={site.announcementBarLink ?? ''}
                readOnly={barPanel.locked}
                inputMode="url"
              />
            </Field>
            <Field label={t('dashboard', 'settings.startsAt')} name="startsAt">
              <TextInput
                name="startsAt"
                type="date"
                defaultValue={toDateInput(site.announcementBarStartsAt)}
                readOnly={barPanel.locked}
              />
            </Field>
            <Field label={t('dashboard', 'settings.endsAt')} name="endsAt">
              <TextInput
                name="endsAt"
                type="date"
                defaultValue={toDateInput(site.announcementBarEndsAt)}
                readOnly={barPanel.locked}
              />
            </Field>
          </div>

          {barPanel.locked ? <NoteField /> : null}
        </ActionForm>
      </Panel>

      <Panel
        title={t('dashboard', 'settings.board')}
        note={t('dashboard', 'settings.boardHint')}
        tone={boardPanel.tone}
        actions={<CapabilityTag capability={boardPanel.capability} />}
      >
        {boardPanel.locked ? (
          <LockedNotice capability={boardPanel.capability} quota={quota} />
        ) : null}

        {announcements.length === 0 ? (
          <Empty>{t('dashboard', 'settings.boardEmpty')}</Empty>
        ) : (
          <div className="sbd-table-scroll">
            <table className="sbd-table">
              <caption className="sbd-hint">{t('dashboard', 'settings.board')}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('dashboard', 'settings.boardTitle')}</th>
                  <th scope="col">{t('dashboard', 'settings.startsAt')}</th>
                  <th scope="col">{t('dashboard', 'settings.endsAt')}</th>
                  <th scope="col">{t('dashboard', 'settings.boardPublished')}</th>
                  {boardPanel.locked ? null : (
                    <th scope="col">
                      <span className="sbd-hint">{t('common', 'actions.delete')}</span>
                    </th>
                  )}
                </tr>
              </thead>
              <tbody>
                {announcements.map((announcement) => (
                  <tr key={announcement.id}>
                    <th scope="row">{announcement.title}</th>
                    <td>{announcement.startsAt ? formatDate(announcement.startsAt) : '—'}</td>
                    <td>{announcement.endsAt ? formatDate(announcement.endsAt) : '—'}</td>
                    <td>
                      <Tag
                        label={t(
                          'dashboard',
                          announcement.published
                            ? 'products.status.published'
                            : 'products.status.hidden',
                        )}
                        tone={announcement.published ? 'ok' : 'muted'}
                      />
                    </td>
                    {boardPanel.locked ? null : (
                      <td>
                        <form action={deleteAnnouncementAction}>
                          <input type="hidden" name="announcementId" value={announcement.id} />
                          <button type="submit" className="sbd-btn sbd-btn--sm">
                            {t('common', 'actions.delete')}
                          </button>
                        </form>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <ActionForm
          action={saveAnnouncementAction}
          submitLabel={boardPanel.locked ? boardPanel.submitLabel : t('dashboard', 'settings.boardAdd')}
          disabled={boardPanel.disabled}
        >
          <div className="sbd-grid">
            <Field label={t('dashboard', 'settings.boardTitle')} name="title">
              <TextInput name="title" readOnly={boardPanel.locked} required />
            </Field>
            <Field label={t('dashboard', 'settings.boardLink')} name="link">
              <TextInput name="link" readOnly={boardPanel.locked} inputMode="url" />
            </Field>
            <Field label={t('dashboard', 'settings.startsAt')} name="startsAt">
              <TextInput name="startsAt" type="date" readOnly={boardPanel.locked} />
            </Field>
            <Field label={t('dashboard', 'settings.endsAt')} name="endsAt">
              <TextInput name="endsAt" type="date" readOnly={boardPanel.locked} />
            </Field>
          </div>

          <Field label={t('dashboard', 'settings.boardBody')} name="body">
            <TextArea name="body" rows={3} readOnly={boardPanel.locked} />
          </Field>

          <Checkbox
            name="published"
            label={t('dashboard', 'settings.boardPublished')}
            defaultChecked
            disabled={boardPanel.locked}
          />
          <input type="hidden" name="sort" value={formatNumber(announcements.length)} />

          {boardPanel.locked ? <NoteField /> : null}
        </ActionForm>
      </Panel>

      <Panel title={t('dashboard', 'lockedField.openRequests')}>
        {requests.length === 0 ? (
          <Empty>{t('dashboard', 'lockedField.noRequests')}</Empty>
        ) : (
          <div className="sbd-table-scroll">
            <table className="sbd-table">
              <caption className="sbd-hint">{t('dashboard', 'lockedField.openRequests')}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('dashboard', 'lockedField.notice')}</th>
                  <th scope="col">{t('dashboard', 'settings.startsAt')}</th>
                  <th scope="col">{t('dashboard', 'lockedField.note')}</th>
                </tr>
              </thead>
              <tbody>
                {requests.map((request) => (
                  <tr key={request.id}>
                    <th scope="row">
                      {t('dashboard', `capabilities.${request.capabilityKey}`)}
                      <span className="sbd-hint">
                        {t('dashboard', `lockedField.requestStatus.${request.status}`)}
                      </span>
                    </th>
                    <td>{formatDate(request.createdAt)}</td>
                    <td>{request.decisionNote ?? request.note ?? '—'}</td>
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

/** The one extra field a locked panel adds: what the merchant actually wants changed. */
function NoteField() {
  return (
    <Field
      label={t('dashboard', 'lockedField.note')}
      name="note"
      hint={t('dashboard', 'lockedField.noteHint')}
    >
      <TextArea name="note" rows={3} />
    </Field>
  );
}
