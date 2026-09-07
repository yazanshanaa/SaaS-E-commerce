import { notFound } from 'next/navigation';
import { getSiteContent } from '@/server/admin';
import {
  COLOR_PRESETS,
  TEMPLATES,
  TEMPLATE_KEYS,
  socialPlatformSchema,
} from '@/shared/site-contract';
import { formatDate, formatNumber, t } from '@/shared/i18n';
import { mapLinkFor } from '@/shared/map-url';
import { TemplatePreview } from '@/app/_components/kit/template-preview';
import { param, requireAdminPage } from '../../../_components/guard';
import { ActionForm } from '../../../_components/action-form';
import { Empty, Field, Notice, Panel, SwitchButton, TextInput } from '../../../_components/ui';
import { saveBusinessDetailsAction } from '../actions';
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
  /** Rebuilt from the stored pair so the link box is not blank on a shop that has a location. */
  const storedMapLink = mapLinkFor(site.mapLat, site.mapLng);
  /* The same string `mapLinkFor` already built — one builder, so the box and the button agree. */
  const mapsHref = storedMapLink;
  const wazeHref = site.mapLat !== null && site.mapLng !== null
    ? `https://waze.com/ul?ll=${site.mapLat},${site.mapLng}&navigate=yes`
    : null;

  return (
    <>
      <Notice okKey={param(query, 'ok')} errorKey={param(query, 'error')} />

      <Panel title={t('admin', 'content.title')} note={t('admin', 'content.subtitle')}>
        <p className="sba-hint">{t('admin', 'permissions.adminNote')}</p>
      </Panel>

      {/*
        THE SHOP'S OWN IDENTITY, EDITABLE FROM HERE (2026-09-06, owner-directed).

        Everything else about a shop was already reachable from this surface — template, palette,
        social links, map pin, section order, feature flags — except its NAME, which is the thing
        merchants phone about most. The only route to it was impersonation, which is a support tool
        being used as a data-entry tool and writes the merchant into the audit log as the author.

        It is FIRST on the page on purpose: the operator opening this tab during a phone call is
        almost always here for one of these seven fields, not for the announcement scheduler.

        The panel is deliberately open regardless of the `settings` capability. Access axis (b)
        decides what the MERCHANT may edit; the operator's own permission to write a tenant's content
        is what this whole screen is (see `src/server/admin/site-content.ts`).
      */}
      <Panel title={t('admin', 'content.business.title')} note={t('admin', 'content.business.hint')}>
        <ActionForm action={saveBusinessDetailsAction} submitLabel={t('admin', 'account.save')}>
          <input type="hidden" name="tenantId" value={tenantId} />

          <div className="sba-row">
            <Field label={t('admin', 'content.business.name')} name="name">
              <TextInput name="name" defaultValue={site.name} required />
            </Field>
            <Field label={t('admin', 'content.business.tagline')} name="tagline">
              <TextInput name="tagline" defaultValue={site.tagline ?? ''} />
            </Field>
          </div>

          <Field label={t('admin', 'content.business.about')} name="about">
            <textarea
              className="sba-textarea"
              id="about"
              name="about"
              rows={4}
              defaultValue={site.about ?? ''}
            />
          </Field>

          <div className="sba-row">
            <Field label={t('admin', 'content.business.address')} name="address">
              <TextInput name="address" defaultValue={site.address ?? ''} />
            </Field>
            <Field label={t('admin', 'content.business.phone')} name="phone">
              <TextInput name="phone" defaultValue={site.phone ?? ''} />
            </Field>
            <Field
              label={t('admin', 'content.business.whatsapp')}
              name="whatsapp"
              hint={t('admin', 'content.business.whatsappHint')}
            >
              <TextInput name="whatsapp" defaultValue={site.whatsapp ?? ''} />
            </Field>
            <Field label={t('admin', 'content.business.email')} name="email">
              <TextInput name="email" defaultValue={site.email ?? ''} />
            </Field>
          </div>

          {/*
            No hours field here on purpose — the structured week on the merchant's `/content/hours`
            is the one editor for that fact now, and a third box for it is the exact duplication this
            change set removed. `saveBusinessDetails` refuses to write it.
          */}
          <p className="sba-hint">{t('admin', 'content.business.hoursNote')}</p>
        </ActionForm>
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
          {/*
            ONE LINK BOX, matching the merchant's own screen (2026-09-06, owner-directed). Nobody —
            operator or merchant — knows a shop's latitude; what they have is the link «مشاركة» put
            on their clipboard. `parseMapLink` extracts the pair in the action and the COLUMNS are
            unchanged, so `resolveMapTarget`, the Waze deep link and the audit entry all still see
            coordinates. Pre-filled from the stored pair so «احفظ» on an untouched form is not a
            silent delete.
          */}
          <Field
            label={t('admin', 'content.mapLink')}
            name="mapLink"
            hint={t('admin', 'content.mapLinkHint')}
          >
            <TextInput name="mapLink" defaultValue={storedMapLink ?? ''} dir="ltr" />
          </Field>

          <Field
            label={t('admin', 'content.mapQuery')}
            name="mapQuery"
            hint={t('admin', 'content.mapQueryHint')}
          >
            <TextInput name="mapQuery" defaultValue={site.mapQuery ?? ''} />
          </Field>
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

      <Panel title={t('admin', 'content.sections')} note={t('admin', 'content.sectionsOrderHint')}>
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
            {content.sections.map((section, index) => {
              /*
                «الترتيب فوق وتحت غير مفهوم» (2026-09-06, owner-directed), and it was three separate
                problems wearing one complaint:

                  1. NO POSITION WAS SHOWN. Two bare buttons labelled «فوق» and «تحت» tell you what
                     they do and nothing about where you are. «٣ من ٧» does, and it also makes the
                     disabled state legible — the first row's «فوق» is greyed because it is FIRST,
                     which is only obvious once the number is on screen.
                  2. THE PAGE JUMPED TO THE TOP after every click, so the operator lost their place
                     on every step of a reorder. Fixed by the anchor below.
                  3. THE ORDER OF THE PAGE was not stated. The list is the home page top-to-bottom,
                     and the panel note now says so.
              */
              const anchor = `sec-${section.id}`;

              return (
                <div className="sba-matrix-row" id={anchor} key={section.id}>
                  <div>
                    <span className="sba-matrix-name">
                      {t('admin', `sections.${section.type}`)}
                    </span>
                    <span className="sba-matrix-default">
                      {t('admin', 'content.sectionPosition', {
                        index: formatNumber(index + 1),
                        total: formatNumber(content.sections.length),
                      })}
                      {' · '}
                      {section.enabled
                        ? t('admin', 'content.sectionShown')
                        : t('admin', 'content.sectionHidden')}
                    </span>
                  </div>

                  <div className="sba-matrix-control">
                    <form action={toggleSectionAction}>
                      <input type="hidden" name="tenantId" value={tenantId} />
                      <input type="hidden" name="sectionId" value={section.id} />
                      <input type="hidden" name="anchor" value={anchor} />
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
                      <input type="hidden" name="anchor" value={anchor} />
                      {/*
                        The accessible name says WHICH section moves, not just «فوق». Seven rows of
                        identically-named buttons is a screen a keyboard or voice user cannot
                        address; the visible label stays short because the row gives it context.
                      */}
                      <button
                        type="submit"
                        className="sba-btn sba-btn--sm"
                        disabled={index === 0}
                        aria-label={t('admin', 'content.moveUpNamed', {
                          name: t('admin', `sections.${section.type}`),
                        })}
                      >
                        {t('admin', 'content.moveUp')}
                      </button>
                    </form>
                    <form action={moveSectionAction}>
                      <input type="hidden" name="tenantId" value={tenantId} />
                      <input type="hidden" name="sectionId" value={section.id} />
                      <input type="hidden" name="direction" value="down" />
                      <input type="hidden" name="anchor" value={anchor} />
                      <button
                        type="submit"
                        className="sba-btn sba-btn--sm"
                        disabled={index === content.sections.length - 1}
                        aria-label={t('admin', 'content.moveDownNamed', {
                          name: t('admin', `sections.${section.type}`),
                        })}
                      >
                        {t('admin', 'content.moveDown')}
                      </button>
                    </form>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Panel>
    </>
  );
}
