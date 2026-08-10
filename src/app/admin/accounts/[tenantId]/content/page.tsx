import { notFound } from 'next/navigation';
import { getSiteContent } from '@/server/admin';
import { socialPlatformSchema } from '@/shared/site-contract';
import { formatDate, t } from '@/shared/i18n';
import { param, requireAdminPage } from '../../../_components/guard';
import { ActionForm } from '../../../_components/action-form';
import { Empty, Field, Notice, Panel, SwitchButton, TextInput } from '../../../_components/ui';
import {
  deleteAnnouncementAction,
  moveSectionAction,
  saveAnnouncementAction,
  saveAnnouncementBarAction,
  saveMapLocationAction,
  saveSocialLinksAction,
  seedSectionsAction,
  toggleSectionAction,
} from './actions';

export const dynamic = 'force-dynamic';

const PLATFORMS = socialPlatformSchema.options;

/** `<input type="date">` wants `YYYY-MM-DD`; a null date is an empty field, never today. */
function dateValue(date: Date | null): string {
  return date ? date.toISOString().slice(0, 10) : '';
}

export default async function AccountContentPage({
  params,
  searchParams,
}: {
  params: Promise<{ tenantId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { tenantId } = await params;
  const ctx = await requireAdminPage();
  const query = await searchParams;

  const content = await getSiteContent(ctx, tenantId);
  if (!content) notFound();

  const site = content.site;
  const socialByPlatform = new Map(content.socialLinks.map((link) => [link.platform, link]));
  const mapsHref = site.mapLat !== null && site.mapLng !== null
    ? `https://www.google.com/maps/search/?api=1&query=${site.mapLat},${site.mapLng}`
    : null;
  const wazeHref = site.mapLat !== null && site.mapLng !== null
    ? `https://waze.com/ul?ll=${site.mapLat},${site.mapLng}&navigate=yes`
    : null;

  return (
    <>
      <Notice okKey={param(query, 'ok')} errorKey={param(query, 'error')} />

      <Panel title={t('admin', 'content.title')} note={t('admin', 'content.subtitle')}>
        <p className="sba-hint">{t('admin', 'permissions.adminNote')}</p>
      </Panel>

      <Panel title={t('admin', 'content.socialLinks')} note={t('admin', 'content.socialLinksHint')}>
        <ActionForm action={saveSocialLinksAction} submitLabel={t('admin', 'account.save')}>
          <input type="hidden" name="tenantId" value={tenantId} />
          <div className="sba-row">
            {PLATFORMS.map((platform) => {
              const existing = socialByPlatform.get(platform);
              return (
                <Field
                  key={platform}
                  label={t('admin', `social.${platform}`)}
                  name={`url-${platform}`}
                >
                  <TextInput
                    name={`url-${platform}`}
                    type="url"
                    defaultValue={existing?.url ?? ''}
                  />
                  <label className="sba-check" htmlFor={`enabled-${platform}`}>
                    <input
                      id={`enabled-${platform}`}
                      type="checkbox"
                      name={`enabled-${platform}`}
                      defaultChecked={existing?.enabled ?? true}
                    />
                    <span>{t('admin', 'content.enabled')}</span>
                  </label>
                </Field>
              );
            })}
          </div>
        </ActionForm>
      </Panel>

      <Panel title={t('admin', 'content.mapLocation')} note={t('admin', 'content.mapHint')}>
        <ActionForm action={saveMapLocationAction} submitLabel={t('admin', 'account.save')}>
          <input type="hidden" name="tenantId" value={tenantId} />
          <div className="sba-row">
            <Field label={t('admin', 'content.mapLat')} name="mapLat">
              <TextInput name="mapLat" defaultValue={site.mapLat ?? ''} />
            </Field>
            <Field label={t('admin', 'content.mapLng')} name="mapLng">
              <TextInput name="mapLng" defaultValue={site.mapLng ?? ''} />
            </Field>
            <Field label={t('admin', 'content.mapQuery')} name="mapQuery">
              <TextInput name="mapQuery" defaultValue={site.mapQuery ?? ''} />
            </Field>
          </div>
        </ActionForm>

        <p className="sba-actions" style={{ marginBlockStart: 'var(--sb-space-4)' }}>
          {mapsHref && wazeHref ? (
            <>
              <a className="sba-btn sba-btn--sm" href={mapsHref} target="_blank" rel="noreferrer noopener">
                {t('admin', 'content.mapPreviewGoogle')}
              </a>
              <a className="sba-btn sba-btn--sm" href={wazeHref} target="_blank" rel="noreferrer noopener">
                {t('admin', 'content.mapPreviewWaze')}
              </a>
            </>
          ) : (
            <span className="sba-hint">{t('admin', 'content.mapNoLocation')}</span>
          )}
        </p>
      </Panel>

      <Panel
        title={t('admin', 'content.announcementBar')}
        note={t('admin', 'content.announcementBarHint')}
      >
        <ActionForm action={saveAnnouncementBarAction} submitLabel={t('admin', 'account.save')}>
          <input type="hidden" name="tenantId" value={tenantId} />

          <label className="sba-check" htmlFor="enabled">
            <input
              id="enabled"
              type="checkbox"
              name="enabled"
              defaultChecked={site.announcementBarEnabled}
            />
            <span>{t('admin', 'content.enabled')}</span>
          </label>

          <Field label={t('admin', 'content.text')} name="text">
            <TextInput name="text" defaultValue={site.announcementBarText ?? ''} />
          </Field>

          <div className="sba-row">
            <Field label={t('admin', 'content.link')} name="link">
              <TextInput name="link" type="url" defaultValue={site.announcementBarLink ?? ''} />
            </Field>
            <Field
              label={t('admin', 'content.startsAt')}
              name="startsAt"
              hint={t('admin', 'content.scheduleHint')}
            >
              <TextInput
                name="startsAt"
                type="date"
                defaultValue={dateValue(site.announcementBarStartsAt)}
              />
            </Field>
            <Field
              label={t('admin', 'content.endsAt')}
              name="endsAt"
              hint={t('admin', 'content.scheduleHint')}
            >
              <TextInput
                name="endsAt"
                type="date"
                defaultValue={dateValue(site.announcementBarEndsAt)}
              />
            </Field>
          </div>
        </ActionForm>
      </Panel>

      <Panel
        title={t('admin', 'content.announcementsBoard')}
        note={t('admin', 'content.announcementsBoardHint')}
      >
        {content.announcements.length === 0 ? (
          <Empty>{t('admin', 'content.noAnnouncements')}</Empty>
        ) : (
          <div className="sba-stack" style={{ marginBlockEnd: 'var(--sb-space-6)' }}>
            {content.announcements.map((announcement) => (
              <div className="sba-item" key={announcement.id}>
                <div className="sba-item-head">
                  <strong>{announcement.title}</strong>
                  {/* A div, not a span: it holds a <form>, which is flow content. */}
                  <div className="sba-actions">
                    <span className="sba-chip">
                      {announcement.published
                        ? t('admin', 'content.published')
                        : t('admin', 'permissions.hidden')}
                    </span>
                    {announcement.startsAt || announcement.endsAt ? (
                      <span className="sba-chip sba-num">
                        {`${announcement.startsAt ? formatDate(announcement.startsAt) : '—'} … ${
                          announcement.endsAt ? formatDate(announcement.endsAt) : '—'
                        }`}
                      </span>
                    ) : null}
                    <form action={deleteAnnouncementAction}>
                      <input type="hidden" name="tenantId" value={tenantId} />
                      <input type="hidden" name="announcementId" value={announcement.id} />
                      <button type="submit" className="sba-btn sba-btn--sm">
                        {t('common', 'actions.delete')}
                      </button>
                    </form>
                  </div>
                </div>
                {announcement.body ? <p className="sba-hint">{announcement.body}</p> : null}
              </div>
            ))}
          </div>
        )}

        <ActionForm action={saveAnnouncementAction} submitLabel={t('admin', 'content.addAnnouncement')}>
          <input type="hidden" name="tenantId" value={tenantId} />
          <Field label={t('admin', 'content.announcementTitle')} name="title">
            <TextInput name="title" required />
          </Field>
          <Field label={t('admin', 'content.announcementBody')} name="body">
            <textarea className="sba-textarea" id="body" name="body" />
          </Field>
          <div className="sba-row">
            <Field label={t('admin', 'content.link')} name="link">
              <TextInput name="link" type="url" />
            </Field>
            <Field label={t('admin', 'content.startsAt')} name="startsAt">
              <TextInput name="startsAt" type="date" />
            </Field>
            <Field label={t('admin', 'content.endsAt')} name="endsAt">
              <TextInput name="endsAt" type="date" />
            </Field>
          </div>
          <label className="sba-check" htmlFor="published">
            <input id="published" type="checkbox" name="published" defaultChecked />
            <span>{t('admin', 'content.published')}</span>
          </label>
          <input type="hidden" name="sort" value={content.announcements.length} />
        </ActionForm>
      </Panel>

      <Panel title={t('admin', 'content.sections')} note={t('admin', 'content.sectionsHint')}>
        {content.sections.length === 0 ? (
          <>
            <Empty>{t('admin', 'content.noSections')}</Empty>
            {/*
              A freshly created account has a Site but no page structure — billing.createAccount
              writes neither, and B2/B3 do not exist yet. Without this button the storefront has
              nothing to render and "show/hide any section" has nothing to show.
            */}
            <form action={seedSectionsAction} style={{ marginBlockStart: 'var(--sb-space-4)' }}>
              <input type="hidden" name="tenantId" value={tenantId} />
              <button type="submit" className="sba-btn sba-btn--primary">
                {t('admin', 'content.seedSections')}
              </button>
            </form>
          </>
        ) : (
          <div className="sba-matrix">
            {content.sections.map((section, index) => (
              <div className="sba-matrix-row" key={section.id}>
                <div>
                  <span className="sba-matrix-name">{t('admin', `sections.${section.type}`)}</span>
                  <span className="sba-matrix-default">
                    {section.enabled
                      ? t('admin', 'content.sectionShown')
                      : t('admin', 'content.sectionHidden')}
                  </span>
                </div>

                <div className="sba-matrix-control">
                  <form action={toggleSectionAction}>
                    <input type="hidden" name="tenantId" value={tenantId} />
                    <input type="hidden" name="sectionId" value={section.id} />
                    <SwitchButton
                      pressed={section.enabled}
                      label={
                        section.enabled ? t('admin', 'content.hide') : t('admin', 'content.show')
                      }
                    />
                  </form>
                </div>

                <div className="sba-matrix-control">
                  <form action={moveSectionAction}>
                    <input type="hidden" name="tenantId" value={tenantId} />
                    <input type="hidden" name="sectionId" value={section.id} />
                    <input type="hidden" name="direction" value="up" />
                    <button type="submit" className="sba-btn sba-btn--sm" disabled={index === 0}>
                      {t('admin', 'content.moveUp')}
                    </button>
                  </form>
                  <form action={moveSectionAction}>
                    <input type="hidden" name="tenantId" value={tenantId} />
                    <input type="hidden" name="sectionId" value={section.id} />
                    <input type="hidden" name="direction" value="down" />
                    <button
                      type="submit"
                      className="sba-btn sba-btn--sm"
                      disabled={index === content.sections.length - 1}
                    >
                      {t('admin', 'content.moveDown')}
                    </button>
                  </form>
                </div>
              </div>
            ))}
          </div>
        )}
      </Panel>
    </>
  );
}
