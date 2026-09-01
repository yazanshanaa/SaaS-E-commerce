import Link from 'next/link';
import {
  CHANGE_REQUEST_ADDON_AGOROT,
  listChangeRequests,
  type ChangeRequestRow,
} from '@/server/admin';
import { formatAgorot, formatDateTime, formatNumber, t } from '@/shared/i18n';
import { pageParam, param, requireAdminPage } from '../_components/guard';
import { Empty, Notice, PageHead, Panel } from '../_components/ui';
import { applyRequestAction, recordAddonAction, rejectRequestAction } from './actions';

export const dynamic = 'force-dynamic';

/**
 * The change-request queue.
 *
 * The payload is rendered FIELD BY FIELD rather than dumped as JSON: this is a merchant's
 * request in their own words and the person deciding on it needs to read it, not parse it. It
 * is also the one payload in the platform that is meant to be read here — event payloads are
 * never rendered raw in an admin surface (item 13), and the two are easy to confuse.
 */
export default async function ChangeRequestsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = await requireAdminPage();
  const query = await searchParams;

  const statusParam = param(query, 'status');
  const status =
    statusParam === 'applied' || statusParam === 'rejected' || statusParam === 'open'
      ? statusParam
      : undefined;

  const list = await listChangeRequests(ctx, {
    status,
    tenantId: param(query, 'tenant'),
    page: pageParam(query),
  });

  return (
    <>
      <PageHead
        title={t('admin', 'changeRequests.title')}
        subtitle={t('admin', 'changeRequests.subtitle')}
      />

      <Notice okKey={param(query, 'ok')} errorKey={param(query, 'error')} />

      <form className="sba-toolbar" method="get" action="/change-requests">
        <div className="sba-field">
          <label className="sba-label" htmlFor="status">
            {t('admin', 'changeRequests.filterStatus')}
          </label>
          <select className="sba-select" id="status" name="status" defaultValue={status ?? ''}>
            <option value="">{t('admin', 'accounts.all')}</option>
            <option value="open">{t('admin', 'changeRequests.open')}</option>
            <option value="applied">{t('admin', 'changeRequests.applied')}</option>
            <option value="rejected">{t('admin', 'changeRequests.rejected')}</option>
          </select>
        </div>
        <button type="submit" className="sba-btn sba-btn--primary">
          {t('admin', 'accounts.apply')}
        </button>
      </form>

      {list.rows.length === 0 ? (
        <Empty>{t('admin', 'changeRequests.empty')}</Empty>
      ) : (
        <div className="sba-stack">
          {list.rows.map((row) => (
            <RequestCard key={row.id} row={row} />
          ))}
        </div>
      )}
    </>
  );
}

function RequestCard({ row }: { row: ChangeRequestRow }) {
  const overQuota = row.quota.remaining !== null && row.quota.remaining <= 0;
  const decided = row.status !== 'open';

  return (
    <Panel
      title={t('admin', `capabilities.${row.capabilityKey}`)}
      actions={
        <>
          <Link className="sba-btn sba-btn--sm" href={`/accounts/${row.tenantId}`}>
            {row.tenantName}
          </Link>
          <span className="sba-chip">{t('admin', `changeRequests.${row.status}`)}</span>
        </>
      }
    >
      <dl className="sba-kv">
        <div>
          <dt>{t('admin', 'changeRequests.submitted')}</dt>
          <dd className="sba-num">{formatDateTime(row.createdAt)}</dd>
        </div>
        <div>
          <dt>{t('admin', 'changeRequests.quota')}</dt>
          <dd>
            {row.quota.limit === null
              ? t('admin', 'changeRequests.quotaUnlimited')
              : t('admin', 'changeRequests.quotaValue', {
                  used: formatNumber(row.quota.used),
                  limit: formatNumber(row.quota.limit),
                  month: row.quota.windowKey,
                })}
          </dd>
        </div>
        {row.decidedAt ? (
          <div>
            <dt>{t('admin', 'changeRequests.decidedAt')}</dt>
            <dd className="sba-num">{formatDateTime(row.decidedAt)}</dd>
          </div>
        ) : null}
      </dl>

      {row.note ? <p className="sba-hint">{row.note}</p> : null}

      <h3 className="sba-label" style={{ marginBlockStart: 'var(--sb-space-4)' }}>
        {t('admin', 'changeRequests.payload')}
      </h3>
      <dl className="sba-payload">
        {describePayload(row).map((entry) => (
          <div key={entry.label}>
            <dt>{entry.label}</dt>
            <dd>{entry.value}</dd>
          </div>
        ))}
      </dl>

      {!row.payloadValid ? (
        <div className="sba-notice sba-notice--error" role="alert">
          {t('admin', 'changeRequests.unsupportedPayload')}
        </div>
      ) : null}

      {overQuota && !row.addonPaymentId ? (
        <div className="sba-notice sba-notice--error" role="status">
          {t('admin', 'changeRequests.overQuota')}
          <form action={recordAddonAction} style={{ marginBlockStart: 'var(--sb-space-2)' }}>
            <input type="hidden" name="id" value={row.id} />
            <button type="submit" className="sba-btn sba-btn--sm">
              {t('admin', 'changeRequests.recordAddon', {
                amount: formatAgorot(CHANGE_REQUEST_ADDON_AGOROT),
              })}
            </button>
          </form>
        </div>
      ) : null}

      {decided ? (
        row.decisionNote ? (
          <p className="sba-hint">{row.decisionNote}</p>
        ) : null
      ) : (
        <div className="sba-row" style={{ marginBlockStart: 'var(--sb-space-4)' }}>
          <form action={applyRequestAction} className="sba-inline-form">
            <input type="hidden" name="id" value={row.id} />
            <div className="sba-field">
              <label className="sba-label" htmlFor={`apply-note-${row.id}`}>
                {t('admin', 'changeRequests.decisionNote')}
              </label>
              <input
                className="sba-input"
                id={`apply-note-${row.id}`}
                name="decisionNote"
                type="text"
              />
            </div>
            <button type="submit" className="sba-btn sba-btn--primary" disabled={!row.payloadValid}>
              {t('admin', 'changeRequests.applyAction')}
            </button>
          </form>

          <form action={rejectRequestAction} className="sba-inline-form">
            <input type="hidden" name="id" value={row.id} />
            <div className="sba-field">
              <label className="sba-label" htmlFor={`reject-note-${row.id}`}>
                {t('admin', 'changeRequests.decisionNote')}
              </label>
              <input
                className="sba-input"
                id={`reject-note-${row.id}`}
                name="decisionNote"
                type="text"
              />
            </div>
            <button type="submit" className="sba-btn">
              {t('admin', 'changeRequests.rejectAction')}
            </button>
          </form>
        </div>
      )}
    </Panel>
  );
}

interface PayloadEntry {
  label: string;
  value: string;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function scalar(value: unknown): string {
  if (value === null || value === undefined || value === '') return t('admin', 'common.none');
  if (typeof value === 'boolean') return value ? t('admin', 'common.yes') : t('admin', 'common.no');
  return String(value);
}

/** Turn a stored payload into readable Arabic rows, per capability. */
function describePayload(row: ChangeRequestRow): PayloadEntry[] {
  const payload = asRecord(row.payload);

  switch (row.capabilityKey) {
    case 'social_links': {
      const links = Array.isArray(payload.links) ? payload.links : [];
      return links.map((raw) => {
        const link = asRecord(raw);
        const platform = String(link.platform ?? '');
        return {
          label: platform ? t('admin', `social.${platform}`) : t('admin', 'common.value'),
          value: scalar(link.url),
        };
      });
    }

    case 'map_location':
      return [
        { label: t('admin', 'content.mapLat'), value: scalar(payload.mapLat) },
        { label: t('admin', 'content.mapLng'), value: scalar(payload.mapLng) },
        { label: t('admin', 'content.mapQuery'), value: scalar(payload.mapQuery) },
      ];

    case 'announcement_bar':
      return [
        { label: t('admin', 'content.enabled'), value: scalar(payload.enabled) },
        { label: t('admin', 'content.text'), value: scalar(payload.text) },
        { label: t('admin', 'content.link'), value: scalar(payload.link) },
        { label: t('admin', 'content.startsAt'), value: scalar(payload.startsAt) },
        { label: t('admin', 'content.endsAt'), value: scalar(payload.endsAt) },
      ];

    case 'announcements_board': {
      const items = Array.isArray(payload.announcements) ? payload.announcements : [];
      return items.map((raw, index) => ({
        label: `${t('admin', 'content.announcementTitle')} ${formatNumber(index + 1)}`,
        value: scalar(asRecord(raw).title),
      }));
    }

    case 'colors': {
      const mode = String(payload.mode ?? '');
      const entries: PayloadEntry[] = [
        {
          label: t('admin', 'permissions.colorModeLabel'),
          value:
            mode === 'custom'
              ? t('admin', 'permissions.colorModeCustom')
              : t('admin', 'permissions.colorModePreset'),
        },
      ];

      for (const key of ['presetKey', 'primary', 'secondary', 'background', 'surface', 'text']) {
        if (payload[key] !== undefined) {
          entries.push({ label: key, value: scalar(payload[key]) });
        }
      }
      return entries;
    }

    case 'sections_layout': {
      const sections = Array.isArray(payload.sections) ? payload.sections : [];
      return sections.map((raw, index) => {
        const section = asRecord(raw);
        return {
          label: `${t('admin', 'content.sections')} ${formatNumber(index + 1)}`,
          value: section.enabled
            ? t('admin', 'content.sectionShown')
            : t('admin', 'content.sectionHidden'),
        };
      });
    }

    // Phase 8. In practice unreachable while every plan seeds `editable_by: 'merchant'` for
    // this capability (prisma/seed.ts) — but a super admin CAN override it per tenant, and the
    // queue must still render something readable if they ever do.
    case 'order_settings':
      return [
        { label: t('dashboard', 'orderSettings.editWindow'), value: scalar(payload.editWindowMinutes) },
        { label: t('dashboard', 'orderSettings.deliveryFee'), value: scalar(payload.deliveryFeeAgorot) },
        { label: t('dashboard', 'orderSettings.freeDeliveryOver'), value: scalar(payload.freeDeliveryOverAgorot) },
        { label: t('dashboard', 'orderSettings.minOrderAmount'), value: scalar(payload.minOrderAmountAgorot) },
        {
          label: t('dashboard', 'orderSettings.paymentMethods'),
          value: Array.isArray(payload.paymentMethods) ? payload.paymentMethods.join('، ') : scalar(undefined),
        },
        { label: t('dashboard', 'orderSettings.orderingPaused'), value: scalar(payload.orderingPaused) },
      ];

    /**
     * Phase 9's eight.
     *
     * The four collection capabilities are summarised as ONE ROW PER ITEM carrying that item's own
     * heading, which is the same shape `announcements_board` above uses and for the same reason: an
     * operator deciding on a banner board needs to see what the board says, not a JSON blob, and
     * printing every column of six banners would bury the decision. The two structural ones print
     * their fields.
     *
     * `scalar()` is what makes this safe as well as readable — every value on this screen is
     * merchant-authored text rendered as text, and none of these payloads carries a URL the operator
     * is invited to follow.
     */
    case 'banners': {
      const banners = Array.isArray(payload.banners) ? payload.banners : [];
      return banners.map((raw, index) => ({
        label: `${t('admin', 'content.bannerTitle')} ${formatNumber(index + 1)}`,
        value: scalar(asRecord(raw).title),
      }));
    }

    case 'trust_badges': {
      const badges = Array.isArray(payload.badges) ? payload.badges : [];
      return badges.map((raw) => ({
        label: t('admin', 'content.trustBadge'),
        value: scalar(asRecord(raw).title),
      }));
    }

    case 'store_stats': {
      const stats = Array.isArray(payload.stats) ? payload.stats : [];
      return stats.map((raw) => {
        const stat = asRecord(raw);
        return { label: scalar(stat.label), value: scalar(stat.value) };
      });
    }

    case 'opening_hours': {
      const days = Array.isArray(payload.days) ? payload.days : [];
      return days.map((raw) => {
        const day = asRecord(raw);
        const weekday = Number(day.weekday);
        return {
          label: t('admin', `content.weekday${Number.isInteger(weekday) ? weekday : 0}`),
          value: day.closed
            ? t('admin', 'content.dayClosed')
            : `${scalar(day.opensAt)} – ${scalar(day.closesAt)}`,
        };
      });
    }

    case 'logo':
      return [
        { label: t('admin', 'content.logo'), value: scalar(payload.logoMediaId) },
        { label: t('admin', 'content.favicon'), value: scalar(payload.faviconMediaId) },
        { label: t('admin', 'content.ogImage'), value: scalar(payload.ogImageMediaId) },
      ];

    case 'size_guide': {
      const rows = Array.isArray(payload.rows) ? payload.rows : [];
      return [
        { label: t('admin', 'content.sizeGuideScope'), value: scalar(payload.categoryId) },
        {
          label: t('admin', 'content.sizeGuideColumns'),
          value: Array.isArray(payload.columns) ? payload.columns.join('، ') : scalar(undefined),
        },
        { label: t('admin', 'content.sizeGuideRows'), value: formatNumber(rows.length) },
      ];
    }

    case 'delivery_zones': {
      const zones = Array.isArray(payload.zones) ? payload.zones : [];
      return zones.map((raw) => {
        const zone = asRecord(raw);
        const towns = Array.isArray(zone.towns) ? zone.towns.length : 0;
        return {
          label: scalar(zone.name),
          // Fee and coverage together: a zone name alone tells an operator nothing about what
          // approving it charges a customer, which is the whole decision.
          value: `${formatNumber(Number(zone.feeAgorot ?? 0))} · ${formatNumber(towns)}`,
        };
      });
    }

    case 'tax_settings':
      return [
        { label: t('admin', 'content.legalName'), value: scalar(payload.legalName) },
        { label: t('admin', 'content.businessNumber'), value: scalar(payload.businessNumber) },
        { label: t('admin', 'content.vatRate'), value: scalar(payload.vatRateBasisPoints) },
      ];
  }
}
