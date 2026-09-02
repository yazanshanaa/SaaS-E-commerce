import Link from 'next/link';
import { canBool } from '@/server/entitlements';
import { t } from '@/shared/i18n';
import { param, requireMerchantPage } from '../_components/guard';
import { Notice, PageHead, Panel } from '../_components/ui';

/**
 * The hub for everything that fills the homepage: banners, the trust row, opening hours, the store
 * stats, the two text strips, and the shop's marks.
 *
 * It exists because these are six screens rather than one, and six nav entries for one job would
 * bury the four a merchant uses monthly under the two they touch once. Each card is offered only when
 * the plan includes it — "invisible rather than disabled with an upgrade prompt" is the criterion
 * `settings/advanced` states, and it is the kinder shape: a basic-plan shop owner has no use for a
 * greyed-out box explaining what they are not paying for.
 *
 * `/content/strips` is unconditional, and that is not an oversight — see the note in
 * `_lib/homepage.ts`: neither strip has a feature key, because the announcement bar has been a base
 * capability since Phase 1 and Phase 9 added the second as a column set beside it.
 */
export const dynamic = 'force-dynamic';

export default async function ContentPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = await requireMerchantPage('settings');
  const params = await searchParams;

  const [banners, extras, branding] = await Promise.all([
    canBool(ctx.tenantId, 'banners_slider'),
    canBool(ctx.tenantId, 'homepage_extras'),
    canBool(ctx.tenantId, 'logo_upload'),
  ]);

  const cards: Array<{ href: string; titleKey: string; noteKey: string }> = [
    ...(banners
      ? [{ href: '/content/banners', titleKey: 'banners.title', noteKey: 'banners.subtitle' }]
      : []),
    ...(extras
      ? [
          { href: '/content/badges', titleKey: 'badges.title', noteKey: 'badges.subtitle' },
          { href: '/content/hours', titleKey: 'hours.title', noteKey: 'hours.subtitle' },
          { href: '/content/stats', titleKey: 'stats.title', noteKey: 'stats.subtitle' },
        ]
      : []),
    { href: '/content/strips', titleKey: 'strips.title', noteKey: 'strips.subtitle' },
    ...(branding
      ? [{ href: '/content/branding', titleKey: 'branding.title', noteKey: 'branding.subtitle' }]
      : []),
  ];

  return (
    <>
      <PageHead title={t('content', 'hub.title')} subtitle={t('content', 'hub.subtitle')} />

      <Notice okKey={param(params, 'ok')} errorKey={param(params, 'error')} />

      {cards.map((card) => (
        <Panel
          key={card.href}
          title={t('content', card.titleKey)}
          note={t('content', card.noteKey)}
          actions={
            <Link className="sbd-btn sbd-btn--sm" href={card.href}>
              {t('common', 'actions.edit')}
            </Link>
          }
        >
          {/*
            A panel with a heading, a sentence and a link and no body. `Panel` renders `children`
            unconditionally, so the fragment keeps the markup valid without an empty `<div>` that a
            screen reader would announce as a group containing nothing.
          */}
          <></>
        </Panel>
      ))}
    </>
  );
}
