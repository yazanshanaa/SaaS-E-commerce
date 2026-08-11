import { formatDate, t } from '@/shared/i18n';
import { EXAMPLE_HOSTNAME, EXAMPLE_HOSTNAME_LABEL } from '@/server/domains';
import { loadDomains, type DomainRow } from '../../_lib/domains';
import { param, requireMerchantPage } from '../../_components/guard';
import { ActionForm } from '../../_components/action-form';
import {
  BackLink,
  Empty,
  Field,
  Notice,
  PageHead,
  Panel,
  Tag,
  TextInput,
} from '../../_components/ui';
import { addDomainAction, removeDomainAction, verifyDomainAction } from './actions';

/**
 * The custom-domain screen — CNAME only in V1 (Q7).
 *
 * It is deliberately an INSTRUCTIONS page with a form on it, not a form with help text. The
 * merchant is about to edit DNS at a registrar this platform has never heard of, and they will do
 * it once, badly, at 11pm. So the record to create is spelled out with its exact three parts, the
 * Cloudflare warning sits ABOVE the form rather than in a troubleshooting section nobody reaches,
 * and the TXT fallback is shown from the start — because a merchant whose provider refuses a TXT
 * beside a CNAME needs to know that before they start, not after they fail.
 *
 * THE CLOUDFLARE WARNING IS THE MOST IMPORTANT COPY ON THIS PAGE. A proxied ("orange cloud")
 * record is flattened, so the CNAME becomes invisible to every resolver on earth and the ACME
 * challenge never reaches this server. From the merchant's side that is indistinguishable from
 * "your platform is broken", and it is the single most common way this flow fails.
 *
 * Apex domains (`example.com` with no `www`) are NOT offered here. See docs/DOMAINS.md: most
 * providers cannot hold a CNAME at the apex, their ALIAS/ANAME substitutes each behave
 * differently, and an A record at the apex means one server IP change breaks every apex domain on
 * the platform at the same moment.
 */
export const dynamic = 'force-dynamic';

export default async function DomainSettingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = await requireMerchantPage('domain');
  const params = await searchParams;
  const view = await loadDomains(ctx);

  if (!view) return <Empty>{t('common', 'states.empty')}</Empty>;

  const { cap, domains, instructions } = view;

  return (
    <>
      <PageHead
        title={t('dashboard', 'domain.title')}
        subtitle={t('dashboard', 'domain.subtitle')}
        actions={<BackLink href="/settings" label={t('common', 'actions.back')} />}
      />

      <Notice okKey={param(params, 'ok')} errorKey={param(params, 'error')} />

      <Panel title={t('dashboard', 'domain.howTo')} note={t('dashboard', 'domain.howToNote')}>
        {/*
          A definition list, not a table: three named parts of one record, which is exactly what
          every registrar's form asks for and the shape a merchant can match field by field.
        */}
        <dl className="sbd-kv">
          <dt>{t('dashboard', 'domain.recordType')}</dt>
          <dd>
            <code className="sbd-code">CNAME</code>
          </dd>

          <dt>{t('dashboard', 'domain.recordName')}</dt>
          {/*
            The example travels as a PARAMETER, not inside the Arabic sentence. `shop.example.com`
            is a placeholder rather than vocabulary, and `example.com` is RFC 2606 reserved — so a
            merchant who copies it verbatim cannot point at a real business by accident.
          */}
          <dd className="sbd-hint">
            {t('dashboard', 'domain.recordNameHint', {
              example: EXAMPLE_HOSTNAME,
              label: EXAMPLE_HOSTNAME_LABEL,
            })}
          </dd>

          <dt>{t('dashboard', 'domain.recordValue')}</dt>
          <dd>
            <code className="sbd-code">{instructions.cnameTarget}</code>
          </dd>
        </dl>

        <div className="sbd-notice sbd-notice--error" role="note">
          <strong>{t('dashboard', 'domain.cloudflareTitle')}</strong>
          <p>{t('dashboard', 'domain.cloudflareBody')}</p>
        </div>

        {/*
          The TXT block appears only once a domain row exists, because only then does its value.
          The token is minted per domain when the row is created; rendering a freshly generated one
          beforehand would print a different value on every reload, store none of them, and send a
          merchant off to publish a record that could never verify.
        */}
        <p className="sbd-panel-note">
          {instructions.txtValue
            ? t('dashboard', 'domain.txtAlternative')
            : t('dashboard', 'domain.txtAfterAdd')}
        </p>

        {instructions.txtValue ? (
          <dl className="sbd-kv">
            <dt>{t('dashboard', 'domain.recordType')}</dt>
            <dd>
              <code className="sbd-code">TXT</code>
            </dd>

            <dt>{t('dashboard', 'domain.recordName')}</dt>
            <dd>
              <code className="sbd-code">{instructions.txtLabel}</code>
              <span className="sbd-hint">{t('dashboard', 'domain.txtNameHint')}</span>
            </dd>

            <dt>{t('dashboard', 'domain.recordValue')}</dt>
            <dd>
              <code className="sbd-code">{instructions.txtValue}</code>
            </dd>
          </dl>
        ) : null}

        <p className="sbd-panel-note">
          {t('dashboard', 'domain.apexNote', { example: EXAMPLE_HOSTNAME })}
        </p>
      </Panel>

      <Panel title={t('dashboard', 'domain.yours')}>
        {domains.length === 0 ? (
          <Empty>{t('dashboard', 'domain.none')}</Empty>
        ) : (
          <ul className="sbd-sortable">
            {domains.map((domain) => (
              <DomainCard key={domain.id} domain={domain} />
            ))}
          </ul>
        )}
      </Panel>

      {cap.remaining > 0 ? (
        <Panel title={t('dashboard', 'domain.add')} note={t('dashboard', 'domain.addHint')}>
          <ActionForm action={addDomainAction} submitLabel={t('dashboard', 'domain.add')}>
            <Field
              label={t('dashboard', 'domain.hostname')}
              name="hostname"
              hint={t('dashboard', 'domain.hostnameHint', { example: EXAMPLE_HOSTNAME })}
            >
              <TextInput name="hostname" inputMode="url" autoComplete="off" required />
            </Field>
          </ActionForm>
        </Panel>
      ) : (
        /*
          The cap is reached, so the form is GONE rather than disabled — there is nothing useful
          a merchant can do with a box that refuses everything. `domains_limit` is 1 on every plan
          that has the feature, so this is the ordinary state once a domain is connected, not an
          error state.
        */
        <Panel title={t('dashboard', 'domain.add')}>
          <Empty>{t('dashboard', 'domain.capReached', { limit: cap.limit })}</Empty>
        </Panel>
      )}
    </>
  );
}

function DomainCard({ domain }: { domain: DomainRow }) {
  const tone = domain.status === 'active' ? 'ok' : domain.status === 'failed' ? 'locked' : 'muted';

  return (
    <li>
      <div className="sbd-sortable-name">
        <span>{domain.hostname}</span>
        <span className="sbd-hint">
          {domain.status === 'active' && domain.activatedAt
            ? t('dashboard', 'domain.activeSince', { date: formatDate(domain.activatedAt) })
            : domain.status === 'verified' && domain.verifiedAt
              ? t('dashboard', 'domain.verifiedOn', { date: formatDate(domain.verifiedAt) })
              : t('dashboard', 'domain.awaitingRecord')}
        </span>
        {/*
          The last failure, in the merchant's language and naming the remedy. It is a message KEY
          stored on the row, never a resolver's English error — see `_lib/domains.ts`.
        */}
        {domain.failureKey ? (
          <span className="sbd-hint">{t('dashboard', keyPath(domain.failureKey))}</span>
        ) : null}
      </div>

      <Tag label={t('dashboard', `domain.status.${domain.status}`)} tone={tone} />

      <form action={verifyDomainAction}>
        <input type="hidden" name="domainId" value={domain.id} />
        <button type="submit" className="sbd-btn sbd-btn--sm">
          {t('dashboard', 'domain.verify')}
        </button>
      </form>

      <form action={removeDomainAction}>
        <input type="hidden" name="domainId" value={domain.id} />
        <button type="submit" className="sbd-btn sbd-btn--sm">
          {t('common', 'actions.delete')}
        </button>
      </form>
    </li>
  );
}

/** `dashboard:domain.errors.proxied` -> `domain.errors.proxied`. The namespace is already known. */
function keyPath(messageKey: string): string {
  const separator = messageKey.indexOf(':');
  return separator === -1 ? messageKey : messageKey.slice(separator + 1);
}
