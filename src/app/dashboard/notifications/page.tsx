import { formatDateTime, formatNumber, t } from '@/shared/i18n';
import { EXAMPLE_TARGET_PATH } from '@/server/push';
import { loadNotifications } from '../_lib/notifications';
import { requireMerchantPage } from '../_components/guard';
import { ActionForm } from '../_components/action-form';
import {
  Empty,
  Field,
  PageHead,
  Panel,
  Stat,
  Tag,
  TextArea,
  TextInput,
} from '../_components/ui';
import { sendPushAction } from './actions';

/**
 * "إشعارات الزبائن" — compose a Web Push notification and see what happened to the last twenty.
 *
 * Behind `push_notifications` (احترافي only) on BOTH axes: `requireMerchantPage('notifications')`
 * answers 404 for a متجر merchant who guesses the URL, and the nav never offers the link. A
 * refused scope is a 404 rather than a 403 throughout this surface — telling someone a screen
 * exists and is not theirs is an inventory of what to come back for.
 *
 * THE THREE NUMBERS AT THE TOP ARE THE POINT OF THE SCREEN. A notification cannot be taken back
 * and is judged by people who can silence the shop permanently with one swipe, so the merchant
 * sees, before they type a word: how many devices this reaches, how many sends they have left
 * today, and what the last one actually achieved. Everything else here is a form.
 */
export const dynamic = 'force-dynamic';

export default async function NotificationsPage() {
  const ctx = await requireMerchantPage('notifications');
  const view = await loadNotifications(ctx);

  const exhausted = view.quota.remaining <= 0;
  const silent = view.audience === 0;

  return (
    <>
      <PageHead
        title={t('dashboard', 'notifications.title')}
        subtitle={t('dashboard', 'notifications.subtitle')}
      />

      <Panel>
        <dl className="sbd-stats">
          <Stat
            label={t('dashboard', 'notifications.audience')}
            value={formatNumber(view.audience)}
            note={t('dashboard', 'notifications.audienceNote')}
          />
          <Stat
            label={t('dashboard', 'notifications.remaining')}
            value={formatNumber(view.quota.remaining)}
            note={t('dashboard', 'notifications.remainingNote', { limit: view.quota.limit })}
          />
        </dl>
      </Panel>

      <Panel
        title={t('dashboard', 'notifications.compose')}
        note={t('dashboard', 'notifications.composeHint')}
      >
        {/*
          The two blocking conditions are stated ABOVE the form rather than only enforced by it.
          A merchant who writes an offer and then learns it cannot be sent has wasted the one
          thing this screen is asking of them — their attention — and the service refuses both
          cases anyway, so saying so first costs nothing.
        */}
        {silent ? <Empty>{t('dashboard', 'notifications.errors.noAudience')}</Empty> : null}
        {!silent && exhausted ? (
          <Empty>{t('dashboard', 'notifications.errors.quotaExhausted')}</Empty>
        ) : null}

        <ActionForm
          action={sendPushAction}
          submitLabel={t('dashboard', 'notifications.send')}
          disabled={silent || exhausted}
        >
          <Field
            label={t('dashboard', 'notifications.fields.title')}
            name="title"
            hint={t('dashboard', 'notifications.fields.titleHint', { max: view.limits.title })}
          >
            <TextInput name="title" required />
          </Field>

          <Field
            label={t('dashboard', 'notifications.fields.body')}
            name="body"
            hint={t('dashboard', 'notifications.fields.bodyHint', { max: view.limits.body })}
          >
            <TextArea name="body" rows={3} required />
          </Field>

          {/*
            The example path travels as a PARAMETER, like the domain screen's example hostname: a
            Latin placeholder does not belong inside an Arabic sentence in the catalogue, and a
            second locale should be free to change it.
          */}
          <Field
            label={t('dashboard', 'notifications.fields.target')}
            name="targetUrl"
            hint={t('dashboard', 'notifications.fields.targetHint', {
              example: EXAMPLE_TARGET_PATH,
            })}
          >
            <TextInput name="targetUrl" inputMode="url" />
          </Field>
        </ActionForm>
      </Panel>

      <Panel title={t('dashboard', 'notifications.history')}>
        {view.history.length === 0 ? (
          <Empty>{t('dashboard', 'notifications.historyEmpty')}</Empty>
        ) : (
          <div className="sbd-table-scroll">
            <table className="sbd-table">
              <caption className="sbd-hint">{t('dashboard', 'notifications.history')}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('dashboard', 'notifications.fields.title')}</th>
                  <th scope="col">{t('dashboard', 'notifications.sentAt')}</th>
                  <th scope="col">{t('dashboard', 'notifications.delivered')}</th>
                  <th scope="col">{t('dashboard', 'notifications.failed')}</th>
                  <th scope="col">{t('dashboard', 'notifications.status')}</th>
                </tr>
              </thead>
              <tbody>
                {view.history.map((message) => (
                  <tr key={message.id}>
                    <th scope="row">
                      {message.title}
                      <span className="sbd-hint">{message.body}</span>
                    </th>
                    <td>{formatDateTime(message.sentAt ?? message.createdAt)}</td>
                    <td className="sbd-num">{formatNumber(message.deliveredCount)}</td>
                    <td className="sbd-num">{formatNumber(message.failedCount)}</td>
                    <td>
                      <Tag
                        label={t('dashboard', `notifications.statuses.${message.status}`)}
                        tone={
                          message.status === 'sent'
                            ? 'ok'
                            : message.status === 'failed'
                              ? 'locked'
                              : 'muted'
                        }
                      />
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
