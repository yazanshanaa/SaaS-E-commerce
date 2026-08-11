import { t } from '@/shared/i18n';
import { canSelfServeExport } from '../../_lib/export';
import { requireMerchantPage } from '../../_components/guard';
import { BackLink, PageHead, Panel } from '../../_components/ui';
import { notFound } from 'next/navigation';

/**
 * The احترافي self-serve export.
 *
 * It is a LINK to a route handler, not a form posting to a server action, because the answer is
 * a file: the handler builds the archive, mints a ≤1h signed URL and streams the bytes back with
 * a `Content-Disposition`. A server action cannot return a download, and threading a signed URL
 * back through the page would put a storage credential in the merchant's address bar.
 *
 * The path is `/settings/export` and not `/export`, deliberately: `/export/{token}` is on
 * proxy.ts's UNPREFIXED list because it is a link handed to a suspended merchant over WhatsApp
 * (Q18). Taking `/export` for a dashboard screen would collide with a promise already made to
 * someone outside the platform.
 *
 * `data_export` gates this button and NOTHING else. The suspension export runs on every plan,
 * this flag included — a basic-plan merchant whose subscription ends still gets their copy.
 */
export const dynamic = 'force-dynamic';

export default async function ExportPage() {
  const ctx = await requireMerchantPage('export');
  if (!(await canSelfServeExport(ctx))) notFound();

  return (
    <>
      <PageHead
        title={t('dashboard', 'export.title')}
        subtitle={t('dashboard', 'export.subtitle')}
        actions={<BackLink href="/settings" label={t('common', 'actions.back')} />}
      />

      <Panel title={t('dashboard', 'export.title')} note={t('dashboard', 'export.note')}>
        {/*
          Phase 5, decision (a), said where the merchant is about to act on it. This archive
          carries their CUSTOMERS' names and phone numbers — it may, because getting here took a
          session, an owner role and `data_export`. The suspension copy, whose link opens with no
          login at all, does not. A merchant who later finds no phone numbers in that one must
          already know why.
        */}
        <p className="sbd-panel-note">{t('dashboard', 'export.customersNote')}</p>

        <p className="sbd-actions">
          <a className="sbd-btn sbd-btn--primary" href="/api/dashboard/export" download>
            {t('dashboard', 'export.download')}
          </a>
        </p>
      </Panel>
    </>
  );
}
