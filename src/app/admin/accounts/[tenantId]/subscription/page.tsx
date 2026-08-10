import { notFound } from 'next/navigation';
import { getAccount, listAttachableMedia, listPayments, PAYMENT_KINDS, PAYMENT_METHODS } from '@/server/admin';
import { addMonths, jerusalemDateKey } from '@/server/time';
import { formatAgorot, formatDate, formatDateTime, t } from '@/shared/i18n';
import { param, requireAdminPage } from '../../../_components/guard';
import { ActionForm } from '../../../_components/action-form';
import { Empty, Field, Notice, Panel, TextInput } from '../../../_components/ui';
import {
  extendAction,
  extendRetentionAction,
  purgeAction,
  reactivateAction,
  recordPaymentAction,
  suspendAction,
} from './actions';

export const dynamic = 'force-dynamic';

export default async function AccountSubscriptionPage({
  params,
  searchParams,
}: {
  params: Promise<{ tenantId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { tenantId } = await params;
  const ctx = await requireAdminPage();
  const query = await searchParams;

  const [account, payments, media] = await Promise.all([
    getAccount(ctx, tenantId),
    listPayments(ctx, tenantId),
    listAttachableMedia(ctx, tenantId),
  ]);
  if (!account) notFound();

  const suspended = account.subscription?.status === 'suspended';
  const defaultPeriodEnd = jerusalemDateKey(addMonths(new Date(), 1));

  return (
    <>
      <Notice okKey={param(query, 'ok')} errorKey={param(query, 'error')} />

      <Panel title={t('admin', 'subscription.actions')} note={t('admin', 'subscription.subtitle')}>
        <div className="sba-stack">
          {!suspended ? (
            <>
              <form action={extendAction} className="sba-inline-form">
                <input type="hidden" name="tenantId" value={tenantId} />
                <Field
                  label={t('admin', 'subscription.extendPeriods')}
                  name="periods"
                  hint={t('admin', 'subscription.extendHint')}
                >
                  <TextInput name="periods" type="number" min="1" max="24" defaultValue={1} />
                </Field>
                <button type="submit" className="sba-btn sba-btn--primary">
                  {t('admin', 'subscription.extend')}
                </button>
              </form>

              <form action={suspendAction} className="sba-inline-form">
                <input type="hidden" name="tenantId" value={tenantId} />
                <button type="submit" className="sba-btn">
                  {t('admin', 'subscription.suspend')}
                </button>
                <span className="sba-hint">{t('admin', 'subscription.suspendHint')}</span>
              </form>
            </>
          ) : (
            <>
              <form action={reactivateAction} className="sba-inline-form">
                <input type="hidden" name="tenantId" value={tenantId} />
                <Field
                  label={t('admin', 'account.periodEnd')}
                  name="currentPeriodEnd"
                  hint={t('admin', 'subscription.reactivateHint')}
                >
                  <TextInput name="currentPeriodEnd" type="date" defaultValue={defaultPeriodEnd} />
                </Field>
                <button type="submit" className="sba-btn sba-btn--primary">
                  {t('admin', 'subscription.reactivate')}
                </button>
              </form>

              <form action={extendRetentionAction} className="sba-inline-form">
                <input type="hidden" name="tenantId" value={tenantId} />
                <Field label={t('admin', 'subscription.extendRetentionDays')} name="days">
                  <TextInput name="days" type="number" min="1" max="365" defaultValue={30} />
                </Field>
                <button type="submit" className="sba-btn">
                  {t('admin', 'subscription.extendRetention')}
                </button>
              </form>
            </>
          )}
        </div>
      </Panel>

      <Panel title={t('admin', 'subscription.recordPayment')}>
        <ActionForm action={recordPaymentAction} submitLabel={t('admin', 'subscription.recordPayment')}>
          <input type="hidden" name="tenantId" value={tenantId} />
          <div className="sba-row">
            <Field label={t('admin', 'subscription.amount')} name="amount">
              <TextInput name="amount" type="number" step="0.01" min="0" required />
            </Field>

            <Field label={t('admin', 'subscription.kind')} name="kind">
              <select className="sba-select" id="kind" name="kind" defaultValue="subscription">
                {PAYMENT_KINDS.map((kind) => (
                  <option key={kind} value={kind}>
                    {t('admin', `paymentKinds.${kind}`)}
                  </option>
                ))}
              </select>
            </Field>

            <Field label={t('admin', 'subscription.method')} name="method">
              <select className="sba-select" id="method" name="method" defaultValue="cash">
                {PAYMENT_METHODS.map((method) => (
                  <option key={method} value={method}>
                    {t('admin', `paymentMethods.${method}`)}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          <Field label={t('admin', 'subscription.note')} name="note">
            <TextInput name="note" />
          </Field>

          <Field
            label={t('admin', 'subscription.attachment')}
            name="attachmentMediaId"
            hint={media.length === 0 ? t('admin', 'subscription.noAttachments') : undefined}
          >
            <select
              className="sba-select"
              id="attachmentMediaId"
              name="attachmentMediaId"
              defaultValue=""
            >
              <option value="">{t('admin', 'subscription.noAttachment')}</option>
              {media.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.originalName ?? item.id}
                </option>
              ))}
            </select>
          </Field>

          <Field
            label={t('admin', 'subscription.extendWithPayment')}
            name="extendPeriods"
            hint={t('admin', 'subscription.extendHint')}
          >
            <TextInput name="extendPeriods" type="number" min="0" max="24" defaultValue={0} />
          </Field>
        </ActionForm>
      </Panel>

      <Panel title={t('admin', 'subscription.payments')}>
        {payments.length === 0 ? (
          <Empty>{t('admin', 'subscription.noPayments')}</Empty>
        ) : (
          <div className="sba-table-wrap">
            <table className="sba-table">
              <caption className="sba-visually-hidden">{t('admin', 'subscription.payments')}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('admin', 'subscription.paidAt')}</th>
                  <th scope="col">{t('admin', 'subscription.kind')}</th>
                  <th scope="col">{t('admin', 'subscription.amount')}</th>
                  <th scope="col">{t('admin', 'subscription.method')}</th>
                  <th scope="col">{t('admin', 'subscription.note')}</th>
                  <th scope="col">{t('admin', 'subscription.recordedBy')}</th>
                </tr>
              </thead>
              <tbody>
                {payments.map((payment) => (
                  <tr key={payment.id}>
                    <td className="sba-num">
                      {payment.paidAt ? formatDate(payment.paidAt) : formatDateTime(payment.createdAt)}
                    </td>
                    <td>{t('admin', `paymentKinds.${payment.kind}`)}</td>
                    <td className="sba-num">{formatAgorot(payment.amountAgorot)}</td>
                    <td>{payment.method ? t('admin', `paymentMethods.${payment.method}`) : '—'}</td>
                    <td>{payment.note ?? '—'}</td>
                    <td>{payment.recordedByName ?? t('admin', 'audit.systemActor')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel title={t('admin', 'subscription.purge')} tone="danger">
        <p className="sba-panel-note">{t('admin', 'subscription.purgeHint')}</p>
        <form action={purgeAction} className="sba-inline-form">
          <input type="hidden" name="tenantId" value={tenantId} />
          <Field
            label={t('admin', 'subscription.purgeConfirmLabel', { slug: account.slug })}
            name="confirmSlug"
          >
            <TextInput name="confirmSlug" required />
          </Field>
          <button type="submit" className="sba-btn sba-btn--danger">
            {t('admin', 'subscription.purge')}
          </button>
        </form>
      </Panel>
    </>
  );
}
