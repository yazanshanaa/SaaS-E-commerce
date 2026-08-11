import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { getEnv } from '@/env';
import { DEMO_PACKS, DEMO_PACK_KEYS } from '@/server/billing';
import { demoRequestContact } from '@/server/demo/requests';
import { readRequestTenant } from '@/server/tenancy';
import { formatNumber, messageExists, t } from '@/shared/i18n';
import { DemoRequestForm } from './form';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: t('demo', 'request.title'),
  // The root layout already refuses indexing; restated here because this is the one PUBLIC page on
  // the platform and a later change to the root default must not quietly expose it.
  robots: { index: false, follow: false },
};

/**
 * `app.{DOMAIN}/demo-request` — the public form (Q2).
 *
 * ROUTING. The `(public)` group is erased from the URL, so this file serves `/demo-request`, which
 * `UNPREFIXED_PATHS` in `src/server/tenancy` keeps out of every surface subtree and
 * `APP_PUBLIC_PREFIXES` in `proxy.ts` exempts from the app surface's session check. Two lists, both
 * already in place before this track started, and neither is edited here.
 *
 * THE SURFACE GUARD. Being unprefixed also means the path is reachable on any hostname the proxy
 * resolves — a merchant's storefront included. The form belongs on `app.{DOMAIN}` and nowhere else,
 * so anything arriving on another surface gets the ordinary 404 rather than a platform sales form
 * rendered under someone else's shop name. The proxy is the only source of that answer (invariant:
 * nothing downstream re-derives the surface).
 */
export default async function DemoRequestPage() {
  const request = readRequestTenant(await headers());
  if (request.surface !== 'app') notFound();

  const env = getEnv();

  const packs = DEMO_PACK_KEYS.map((key) => ({
    value: key,
    label: messageExists('demo', `packs.${key}`) ? t('demo', `packs.${key}`) : DEMO_PACKS[key].label,
  }));

  /**
   * The notice states the ACTUAL rule, and the number comes from the same env var the sweep reads.
   *
   * `docs/PHASES.md` is explicit about this: the data is deleted when the demo is CLOSED, or within
   * the retention window if no demo is ever opened. Promising "deleted with the demo" would be
   * false for a request that is rejected and never becomes one — and that is the majority case for
   * a form anyone can submit. `DemoRequest.purgeAfter` is what makes the second half true, and B1's
   * nightly sweep is what enforces it.
   */
  const retentionNotice = t('demo', 'request.retentionNotice', {
    days: formatNumber(env.DEMO_REQUEST_RETENTION_DAYS),
    contact: demoRequestContact(),
  });

  /**
   * Every label resolved HERE, and handed down as plain strings.
   *
   * `src/shared/i18n` is a static object of all seven namespace files, so importing `t` into the
   * `'use client'` form would put the admin panel's whole catalogue in the bundle of the one page
   * the platform serves to the open internet. The copy still lives in `messages/ar/demo.json`; only
   * the resolution stays on the server. (`request.prefixHint` keeps its `{example}` placeholder —
   * the form fills it in as the box is typed into.)
   */
  const copy = {
    businessName: t('demo', 'request.businessName'),
    businessNameHint: t('demo', 'request.businessNameHint'),
    address: t('demo', 'request.address'),
    addressHint: t('demo', 'request.addressHint'),
    whatsapp: t('demo', 'request.whatsapp'),
    whatsappHint: t('demo', 'request.whatsappHint'),
    prefix: t('demo', 'request.prefix'),
    prefixHint: t('demo', 'request.prefixHint'),
    prefixHelp: t('demo', 'request.prefixHelp'),
    pack: t('demo', 'request.pack'),
    packHint: t('demo', 'request.packHint'),
    packNone: t('demo', 'request.packNone'),
    submit: t('demo', 'request.submit'),
    pending: t('common', 'states.loading'),
    successTitle: t('demo', 'request.successTitle'),
    noticeTitle: t('demo', 'request.noticeTitle'),
    retentionNotice,
  };

  return (
    <div className="sbp-page">
      <header className="sbp-head">
        <h1 className="sbp-title">{t('demo', 'request.title')}</h1>
        <p className="sbp-lead">{t('demo', 'request.intro')}</p>
      </header>

      <DemoRequestForm copy={copy} packs={packs} hostSuffix={`.${env.DOMAIN}`} />
    </div>
  );
}
