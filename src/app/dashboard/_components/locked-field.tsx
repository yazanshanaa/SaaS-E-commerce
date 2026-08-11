import { t } from '@/shared/i18n';
import type { CapabilityView, ChangeRequestQuota } from '../_lib/change-requests';
import { Tag } from './ui';

/**
 * How access axis (b) looks to a merchant.
 *
 * `editable_by = admin` is NOT "the field is disabled". The content still renders on the
 * storefront — somebody has to be able to write it, and on those plans that somebody is the
 * platform owner. So the merchant sees the value, read-only, with a working way to ask for a
 * change and an honest count of how many asks they have left this month.
 *
 * The quota line is the part that has to be exactly right, because it is about money:
 *   - a number, when the plan meters requests (2 on أساسي, 5 on متجر);
 *   - "unlimited", when `change_requests_per_month` is null (احترافي) — null is a real answer
 *     and reading it as zero would block a pro merchant from ever asking for anything;
 *   - and at zero, the ₪25 add-on is EXPLAINED rather than the button silently failing.
 */

export function LockedNotice({
  capability,
  quota,
}: {
  capability: CapabilityView;
  quota: ChangeRequestQuota;
}) {
  return (
    <div className="sbd-notice sbd-notice--info">
      <p>{t('dashboard', 'lockedField.notice')}</p>
      <p className="sbd-hint">{quotaLine(quota)}</p>
      {capability.openRequests > 0 ? (
        <p className="sbd-hint">{t('dashboard', 'lockedField.pending')}</p>
      ) : null}
    </div>
  );
}

export function quotaLine(quota: ChangeRequestQuota): string {
  if (quota.remaining === null) return t('dashboard', 'lockedField.unlimited');
  if (quota.remaining <= 0) return t('dashboard', 'lockedField.exhausted');
  return t('dashboard', 'lockedField.remaining', { count: quota.remaining });
}

export function isExhausted(quota: ChangeRequestQuota): boolean {
  return quota.remaining !== null && quota.remaining <= 0;
}

/** The marker on a panel header, so the state is visible before the panel is read. */
export function CapabilityTag({ capability }: { capability: CapabilityView }) {
  if (capability.editable) return null;
  return <Tag label={t('dashboard', 'lockedField.notice')} tone="locked" />;
}
