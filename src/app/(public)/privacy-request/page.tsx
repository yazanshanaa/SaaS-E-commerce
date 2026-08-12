import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { DSR_KINDS, DSR_SUBJECT_KINDS } from '@/server/dsr';
import { contactEmail } from '@/server/legal';
import { readRequestTenant } from '@/server/tenancy';
import { t } from '@/shared/i18n';
import { PrivacyRequestForm } from './form';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: t('common', 'privacyRequest.title'),
  robots: { index: false, follow: false },
};

/**
 * `app.{DOMAIN}/privacy-request` — the data-subject request box (Phase 6).
 *
 * THIS PAGE IS A PROMISE THE PRIVACY POLICY ALREADY MAKES. `src/server/legal` interpolates this
 * exact absolute URL into the "your rights" clause of every generated policy, on every storefront,
 * so the two ship together or the policy publishes a dead link to the people who have no other way
 * to reach the platform. That is not a hypothetical: docs/PHASES.md names demo prospects — a phone
 * number and a physical address in a global table, belonging to somebody with no account.
 *
 * ROUTING. The `(public)` group is erased from the URL, so this file serves `/privacy-request`,
 * which `UNPREFIXED_PATHS` keeps out of every surface subtree and `APP_PUBLIC_PREFIXES` exempts
 * from the app surface's session check. Both lists were edited in the same commit as this file.
 *
 * THE SURFACE GUARD. Unprefixed also means reachable on any hostname the proxy resolves, including
 * a merchant's storefront. The box belongs to the PLATFORM, so anything arriving elsewhere gets the
 * ordinary 404 rather than a platform form rendered under someone else's shop name — the same guard
 * `/demo-request` uses, for the same reason.
 */
export default async function PrivacyRequestPage() {
  const request = readRequestTenant(await headers());
  if (request.surface !== 'app') notFound();

  /**
   * Every label resolved HERE and handed down as plain strings — the form is a client component and
   * must not import the i18n layer (see `form.tsx`).
   */
  const copy = {
    whoLegend: t('common', 'privacyRequest.who.legend'),
    who: DSR_SUBJECT_KINDS.map((value) => ({
      value,
      label: t('common', `privacyRequest.who.${value}`),
    })),
    kindLegend: t('common', 'privacyRequest.kind.legend'),
    kinds: DSR_KINDS.map((value) => ({
      value,
      label: t('common', `privacyRequest.kind.${value}`),
    })),
    email: t('common', 'privacyRequest.fields.email'),
    emailHint: t('common', 'privacyRequest.fields.emailHint'),
    phone: t('common', 'privacyRequest.fields.phone'),
    phoneHint: t('common', 'privacyRequest.fields.phoneHint'),
    tenantRef: t('common', 'privacyRequest.fields.tenantRef'),
    tenantRefHint: t('common', 'privacyRequest.fields.tenantRefHint'),
    details: t('common', 'privacyRequest.fields.details'),
    detailsHint: t('common', 'privacyRequest.fields.detailsHint'),
    submit: t('common', 'privacyRequest.submit'),
    pending: t('common', 'states.loading'),
    successTitle: t('common', 'privacyRequest.title'),
  };

  return (
    <div className="sbp-page">
      <header className="sbp-head">
        <h1 className="sbp-title">{t('common', 'privacyRequest.title')}</h1>
        <p className="sbp-lead">{t('common', 'privacyRequest.lead')}</p>
      </header>

      <PrivacyRequestForm copy={copy} />

      {/*
        The notice sits BELOW the form, and it says three things the form itself cannot: that the
        phone number is stored hashed and therefore answered on WhatsApp, that the merchant is the
        controller for anything belonging to their shop, and that identity verification asks for as
        little as possible. All three are what the generated privacy policy already promises.
      */}
      <p className="sbp-hint">{t('common', 'privacyRequest.notice')}</p>
      <p className="sbp-hint" dir="ltr">
        {contactEmail()}
      </p>
    </div>
  );
}
