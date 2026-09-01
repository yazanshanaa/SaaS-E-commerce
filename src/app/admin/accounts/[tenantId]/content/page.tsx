import { notFound } from 'next/navigation';
import { getSiteContent } from '@/server/admin';
import {
  COLOR_PRESETS,
  TEMPLATES,
  TEMPLATE_KEYS,
  socialPlatformSchema,
} from '@/shared/site-contract';
import { formatDate, t } from '@/shared/i18n';
import { TemplatePreview } from '@/app/_components/kit/template-preview';
import { param, requireAdminPage } from '../../../_components/guard';
import { ActionForm } from '../../../_components/action-form';
import { Empty, Field, Notice, Panel, SwitchButton, TextInput } from '../../../_components/ui';
import {
  deleteAnnouncementAction,
  moveSectionAction,
  saveAnnouncementAction,
  saveAnnouncementBarAction,
  saveAppearanceAction,
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

      <Panel
        title={t('admin', 'content.appearance.title')}
        note={t('admin', 'content.appearance.hint')}
      >
        <ActionForm
          action={saveAppearanceAction}
          submitLabel={t('admin', 'content.appearance.apply')}
        >
          <input type="hidden" name="tenantId" value={tenantId} />

          <fieldset className="sba-look-group">
            <legend className="sba-label">{t('admin', 'content.appearance.template')}</legend>
            {/*
              The KIT's card grid (Phase 11, 11.G), not the admin-local `sba-look-*` this screen
              shipped with: one class set for all three template pickers — the merchant's studio,
              this screen and `/accounts/new` — so the thing an operator and a merchant are looking
              at while they talk on the phone is the same thing. The card IS the radio; the input
              stays in the tree, clipped rather than `display:none`, so it keeps its tab stop.
            */}
            <div className="sbk-look-grid">
              {TEMPLATE_KEYS.map((key) => {
                const template = TEMPLATES[key];
                return (
                  <label className="sbk-look-pick" key={key}>
                    <input
                      type="radio"
                      name="templateKey"
                      value={key}
                      defaultChecked={site.templateKey === key}
                      required
                    />
                    <span className="sbk-look-pick__shot">
                      <TemplatePreview templateKey={key} />
                    </span>
                    <span className="sbk-look-pick__name">{template.name}</span>
                    <span className="sbk-look-pick__dots" aria-hidden="true">
                      <span
                        className="sbk-look-pick__dot"
                        style={{ background: template.defaults.primary }}
                      />
                      <span
                        className="sbk-look-pick__dot"
                        style={{ background: template.defaults.secondary }}
                      />
                      <span
                        className="sbk-look-pick__dot"
                        style={{ background: template.defaults.background }}
                      />
                    </span>
                    <span className="sbk-look-pick__desc">{template.description}</span>
                  </label>
                );
              })}
            </div>
          </fieldset>

          <fieldset className="sba-look-group">
            <legend className="sba-label">{t('admin', 'content.appearance.preset')}</legend>
            <div className="sbk-look-grid">
              <label className="sbk-look-pick">
                <input
                  type="radio"
                  name="presetKey"
                  value="template_default"
                  defaultChecked={content.theme === null}
                  required
                />
                <span className="sbk-look-pick__name">
                  {t('admin', 'content.appearance.templateDefault')}
                </span>
                <span className="sbk-look-pick__desc">
                  {t('admin', 'content.appearance.templateDefaultHint')}
                </span>
              </label>
              {COLOR_PRESETS.map((preset) => (
                <label className="sbk-look-pick" key={preset.key}>
                  <input
                    type="radio"
                    name="presetKey"
                    value={preset.key}
                    defaultChecked={
                      content.theme?.colorMode === 'preset' &&
                      content.theme.presetKey === preset.key
                    }
                    required
                  />
                  <span className="sbk-look-pick__name">{preset.name}</span>
                  <span className="sbk-look-pick__dots" aria-hidden="true">
                    <span className="sbk-look-pick__dot" style={{ background: preset.primary }} />
                    <span className="sbk-look-pick__dot" style={{ background: preset.secondary }} />
                    <span className="sbk-look-pick__dot" style={{ background: preset.background }} />
                  </span>
                </label>
              ))}
            </div>
            <p className="sba-hint">{t('admin', 'content.appearance.presetHint')}</p>
            {content.theme?.colorMode === 'custom' ? (
              <p className="sba-hint sba-look-warning">
                {t('admin', 'content.appearance.customActive')}
              </p>
            ) : null}
          </fieldset>
        </ActionForm>
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
