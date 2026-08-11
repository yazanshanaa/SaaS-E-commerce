import Link from 'next/link';
import { formatDate, formatNumber, t } from '@/shared/i18n';
import { getSiteDetails, listAnnouncements, listSocialLinks, socialPlatformSchema } from '../_lib/site';
import { loadCapabilityContext, listOwnChangeRequests } from '../_lib/change-requests';
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

  const [site, social, announcements, capabilityContext, requests, hasExport, hasAdvanced] =
    await Promise.all([
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
    ]);

  if (!site) return <Empty>{t('common', 'states.empty')}</Empty>;

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

          <Field
            label={t('dashboard', 'settings.fields.hours')}
            name="hours"
            hint={t('dashboard', 'settings.fields.hoursHint')}
          >
            <TextArea name="hours" defaultValue={site.hours ?? ''} rows={3} />
          </Field>

          {/*
            The logo is carried through as a hidden field rather than being editable here: it is
            a media id, and a text box asking a merchant for one is worse than no control. A
            picker belongs with the media library work; until then this preserves the value A1
            or B3 set instead of blanking it on every save.
          */}
          <input type="hidden" name="logoMediaId" value={site.logoMediaId ?? ''} />
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
          <div className="sbd-grid">
            <Field label={t('dashboard', 'settings.mapLat')} name="mapLat">
              <TextInput
                name="mapLat"
                defaultValue={site.mapLat === null ? '' : String(site.mapLat)}
                readOnly={mapPanel.locked}
                inputMode="decimal"
              />
            </Field>
            <Field label={t('dashboard', 'settings.mapLng')} name="mapLng">
              <TextInput
                name="mapLng"
                defaultValue={site.mapLng === null ? '' : String(site.mapLng)}
                readOnly={mapPanel.locked}
                inputMode="decimal"
              />
            </Field>
            <Field label={t('dashboard', 'settings.mapQuery')} name="mapQuery">
              <TextInput
                name="mapQuery"
                defaultValue={site.mapQuery ?? ''}
                readOnly={mapPanel.locked}
              />
            </Field>
          </div>

          {mapPanel.locked ? <NoteField /> : null}
        </ActionForm>
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
