import Link from 'next/link';
import { DEMO_PACK_KEYS, DEMO_PACKS } from '@/server/billing';
import { formatDate, formatNumber, messageExists, t } from '@/shared/i18n';


/**
 * The demo surface's shared chrome.
 *
 * Two screens — the demos themselves and the request inbox — answer two halves of one job, so they
 * share a header rather than each restating it. Every `href` is the PUBLIC path (`/demos`): proxy.ts
 * owns the `/admin` prefix and it never appears in the URL bar.
 *
 * The panel's styling comes from A1's stylesheet. This track adds no CSS to a shared file, which is
 * why everything below reaches for an existing `sba-*` class rather than inventing one.
 */

const TABS = [
  { href: '/demos', key: 'demos' },
  { href: '/demos/requests', key: 'requests' },
] as const;

/**
 * The tabs, and the ONLY place a new customer request announces itself.
 *
 * `docs/PHASES.md` asks the public form to "notify the admin", and the platform's notification
 * table cannot carry it: `Notification.tenantId` is NOT NULL with a foreign key to `tenants`
 * (`prisma/schema.prisma:1316`), and a demo request exists precisely because no tenant does yet.
 * Making it nullable is a migration, so it belongs to the main session — see sync point 6 in
 * `docs/decisions/b3.md`.
 *
 * A count on the tab is what can be built without one. It is weaker than an out-of-band message —
 * it only reaches an operator who is already in the panel — and it is honest about being the
 * platform's current answer rather than leaving the requirement silently unmet.
 */
export function DemoTabs({ current, pendingRequests = 0 }: { current: string; pendingRequests?: number }) {
  return (
    <nav className="sba-tabs" aria-label={t('demo', 'admin.title')}>
      {TABS.map((tab) => (
        <Link
          key={tab.href}
          className="sba-tab"
          href={tab.href}
          aria-current={tab.href === current ? 'page' : undefined}
        >
          {t('demo', `admin.nav.${tab.key}`)}
          {tab.key === 'requests' && pendingRequests > 0 ? (
            <span className="sba-chip sba-chip--accent">
              {t('demo', 'admin.nav.pendingCount', { count: formatNumber(pendingRequests) })}
            </span>
          ) : null}
        </Link>
      ))}
    </nav>
  );
}

/** The pack options, Arabic labels, in one place so the picker and the inbox cannot disagree. */
export function packOptions(): Array<{ value: string; label: string }> {
  return DEMO_PACK_KEYS.map((key) => ({
    value: key,
    // The pack's own `label` is Arabic production copy; the catalogue holds the same words so the
    // language gate can see them, and `messageExists` keeps a new pack from throwing before its
    // key is added.
    label: messageExists('demo', `packs.${key}`) ? t('demo', `packs.${key}`) : DEMO_PACKS[key].label,
  }));
}

export function packLabel(packKey: string | null): string {
  if (!packKey) return t('demo', 'admin.requests.noPack');
  return messageExists('demo', `packs.${packKey}`) ? t('demo', `packs.${packKey}`) : packKey;
}

/**
 * How old a demo is, and a nudge once it stops looking like an active sales conversation.
 *
 * Demos never expire on a timer (Q2), so this column is the only thing that makes a forgotten one
 * visible. The threshold is a nudge, not a rule: nothing is deleted automatically and nothing
 * should be — a demo six weeks into a slow negotiation is not a mistake.
 */
export const STALE_AFTER_DAYS = 30;

export function DemoAge({ days }: { days: number }) {
  if (days === 0) return <span className="sba-num">{t('demo', 'admin.list.ageToday')}</span>;

  const label = t('demo', 'admin.list.ageDays', { count: formatNumber(days) });
  if (days < STALE_AFTER_DAYS) return <span className="sba-num">{label}</span>;

  /**
   * The warning is TEXT, not a colour and not a `title`.
   *
   * A `title` attribute is not reachable by keyboard, is not announced by several screen readers,
   * and never appears on a touch device — so a chip that turns clay and carries its explanation
   * there says nothing at all to a large share of the people using this screen (WCAG 1.4.1: colour
   * is never the only carrier). The sentence goes in the DOM, visually hidden, where every reader
   * gets it and the chip stays a chip.
   */
  return (
    <span className="sba-chip sba-chip--accent">
      {label}
      <span className="sba-visually-hidden">
        {' — '}
        {t('demo', 'admin.list.stale', { count: formatNumber(days) })}
      </span>
    </span>
  );
}

/**
 * The magic link, shown in full and on purpose.
 *
 * B1's export link is deliberately never printed on an admin screen — it is a bearer token to a
 * merchant's whole catalogue. This one is the opposite: a demo token grants read access to a
 * showcase shop that the platform built and that holds nobody's real data, and the entire workflow
 * is "copy this and send it on WhatsApp". A link an operator cannot see is a link they cannot send.
 */
export function DemoLinkCell({ url, expiresAt }: { url: string | null; expiresAt: Date | null }) {
  if (!url) return <span className="sba-hint">{t('demo', 'admin.list.noLink')}</span>;

  return (
    <span className="sba-stack">
      <a className="sba-mono" href={url} rel="noreferrer noopener" target="_blank">
        {url}
      </a>
      <span className="sba-hint">
        {expiresAt
          ? t('demo', 'admin.list.linkExpires', { date: formatDate(expiresAt) })
          : t('demo', 'admin.list.linkForever')}
      </span>
    </span>
  );
}
