import { formatDate, t } from '@/shared/i18n';
import { listStaff } from '../_lib/staff';
import { param, requireMerchantPage } from '../_components/guard';
import { ActionForm } from '../_components/action-form';
import { Empty, Field, Notice, PageHead, Panel, Tag, TextInput } from '../_components/ui';
import { inviteStaffAction, removeStaffAction, resendInviteAction } from './actions';

/**
 * Staff accounts — احترافي only, and owners only (Q13).
 *
 * The screen exists at all only when `can(tenantId, 'staff_accounts')` is true; the guard 404s
 * otherwise, so a متجر owner who guesses the URL learns nothing about what they are missing.
 *
 * A staff member is products + orders + media. The `orders` scope has no surface until Phase 5,
 * so in V1 a staff member sees products and media — and never appearance, sections, settings,
 * this screen, or anything billing, by navigation OR by URL.
 */
export const dynamic = 'force-dynamic';

export default async function StaffPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = await requireMerchantPage('staff');
  const params = await searchParams;
  const members = await listStaff(ctx);

  return (
    <>
      <PageHead title={t('dashboard', 'staff.title')} subtitle={t('dashboard', 'staff.subtitle')} />

      <Notice okKey={param(params, 'ok')} errorKey={param(params, 'error')} />

      <Panel title={t('dashboard', 'staff.invite')} note={t('dashboard', 'staff.inviteHint')}>
        <ActionForm action={inviteStaffAction} submitLabel={t('dashboard', 'staff.invite')}>
          <div className="sbd-grid">
            <Field label={t('dashboard', 'staff.name')} name="name">
              <TextInput name="name" required />
            </Field>
            <Field label={t('dashboard', 'staff.email')} name="email">
              <TextInput name="email" type="email" inputMode="email" required />
            </Field>
          </div>
        </ActionForm>
      </Panel>

      <Panel title={t('dashboard', 'staff.title')} note={t('dashboard', 'staff.removeConfirm')}>
        {members.length === 0 ? (
          <Empty>{t('dashboard', 'staff.empty')}</Empty>
        ) : (
          <div className="sbd-table-scroll">
            <table className="sbd-table">
              <caption className="sbd-hint">{t('dashboard', 'staff.title')}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('dashboard', 'staff.name')}</th>
                  <th scope="col">{t('dashboard', 'staff.email')}</th>
                  <th scope="col">{t('dashboard', 'shell.roleOwner')}</th>
                  <th scope="col">
                    <span className="sbd-hint">{t('common', 'actions.delete')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {members.map((member) => (
                  <tr key={member.userId}>
                    <th scope="row">
                      {member.name}
                      {member.isSelf ? (
                        <span className="sbd-hint">{t('dashboard', 'staff.you')}</span>
                      ) : null}
                    </th>
                    <td>{member.email}</td>
                    <td>
                      <Tag
                        label={t(
                          'dashboard',
                          member.role === 'owner' ? 'shell.roleOwner' : 'shell.roleStaff',
                        )}
                        tone={member.role === 'owner' ? 'ok' : 'muted'}
                      />
                      <span className="sbd-hint">{formatDate(member.createdAt)}</span>
                    </td>
                    <td>
                      {/*
                        The owner is never removable from here and neither is the person using
                        the screen: removing the last owner would leave a live account nobody can
                        administer, and ownership changes only in A1.
                      */}
                      {member.role === 'staff' && !member.isSelf ? (
                        <>
                          {member.hasCredentials ? null : (
                            <form action={resendInviteAction}>
                              <input type="hidden" name="userId" value={member.userId} />
                              <button type="submit" className="sbd-btn sbd-btn--sm">
                                {t('dashboard', 'staff.resend')}
                              </button>
                            </form>
                          )}
                          <form action={removeStaffAction}>
                            <input type="hidden" name="userId" value={member.userId} />
                            <button type="submit" className="sbd-btn sbd-btn--sm">
                              {t('dashboard', 'staff.remove')}
                            </button>
                          </form>
                        </>
                      ) : null}
                    </td>
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
