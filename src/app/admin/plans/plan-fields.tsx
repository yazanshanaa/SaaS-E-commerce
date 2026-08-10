import { FEATURE_KINDS, type PlanDetail, type StoredFeatureValue } from '@/server/admin';
import { CAPABILITY_KEYS, FEATURE_KEYS } from '@/shared/features';
import { TEMPLATES, TEMPLATE_KEYS } from '@/shared/site-contract';
import { t } from '@/shared/i18n';
import { Field, TextInput } from '../_components/ui';

/**
 * The plan form's fields, shared by "new" and "edit".
 *
 * Prices are entered in shekels and stored in agorot — the conversion happens in the validation
 * layer so no screen ever has to remember the factor of a hundred.
 */
export function PlanFields({ plan }: { plan?: PlanDetail }) {
  return (
    <>
      <fieldset className="sba-fieldset">
        <legend className="sba-legend">{t('admin', 'plans.title')}</legend>

        <div className="sba-row">
          <Field label={t('admin', 'plans.key')} name="key" hint={t('admin', 'plans.keyHint')}>
            {plan ? (
              <>
                <input type="hidden" name="key" value={plan.key} />
                <input className="sba-input" id="key" value={plan.key} readOnly disabled />
              </>
            ) : (
              <TextInput name="key" required />
            )}
          </Field>

          <Field label={t('admin', 'plans.name')} name="name">
            <TextInput name="name" defaultValue={plan?.name ?? ''} required />
          </Field>

          <Field label={t('admin', 'plans.sortOrder')} name="sortOrder">
            <TextInput name="sortOrder" type="number" min="0" defaultValue={plan?.sortOrder ?? 0} />
          </Field>
        </div>

        <Field label={t('admin', 'plans.description')} name="description">
          <textarea
            className="sba-textarea"
            id="description"
            name="description"
            defaultValue={plan?.description ?? ''}
          />
        </Field>

        <div className="sba-row">
          <Field label={t('admin', 'plans.priceMonthly')} name="priceMonthly">
            <TextInput
              name="priceMonthly"
              type="number"
              step="0.01"
              min="0"
              defaultValue={shekels(plan?.priceMonthlyAgorot)}
            />
          </Field>

          <Field label={t('admin', 'plans.priceYearly')} name="priceYearly">
            <TextInput
              name="priceYearly"
              type="number"
              step="0.01"
              min="0"
              defaultValue={shekels(plan?.priceYearlyAgorot)}
            />
          </Field>

          <Field
            label={t('admin', 'plans.setupFee')}
            name="setupFee"
            hint={t('admin', 'plans.setupFeeHint')}
          >
            <TextInput
              name="setupFee"
              type="number"
              step="0.01"
              min="0"
              defaultValue={shekels(plan?.setupFeeAgorot)}
            />
          </Field>
        </div>

        <label className="sba-check" htmlFor="active">
          <input id="active" type="checkbox" name="active" defaultChecked={plan?.active ?? true} />
          <span>{t('admin', 'plans.active')}</span>
        </label>

        <label className="sba-check" htmlFor="hidden">
          <input id="hidden" type="checkbox" name="hidden" defaultChecked={plan?.hidden ?? false} />
          <span>
            {t('admin', 'plans.hidden')}
            <span className="sba-hint">{t('admin', 'plans.hiddenHint')}</span>
          </span>
        </label>
      </fieldset>

      <fieldset className="sba-fieldset">
        <legend className="sba-legend">{t('admin', 'plans.features')}</legend>
        <div className="sba-matrix">
          {FEATURE_KEYS.map((key) => (
            <div className="sba-matrix-row" key={key}>
              <div>
                <span className="sba-matrix-name">{t('admin', `features.${key}`)}</span>
              </div>
              <div className="sba-matrix-control">
                <PlanFeatureControl featureKey={key} value={plan?.features[key]} />
              </div>
              <div />
            </div>
          ))}
        </div>
      </fieldset>

      <fieldset className="sba-fieldset">
        <legend className="sba-legend">{t('admin', 'plans.capabilities')}</legend>
        <div className="sba-matrix">
          {CAPABILITY_KEYS.map((key) => {
            const current = plan?.capabilities[key];
            return (
              <div className="sba-matrix-row" key={key}>
                <div>
                  <span className="sba-matrix-name">{t('admin', `capabilities.${key}`)}</span>
                </div>
                <div className="sba-matrix-control">
                  <label className="sba-check" htmlFor={`cap-visible-${key}`}>
                    <input
                      id={`cap-visible-${key}`}
                      type="checkbox"
                      name={`cap-visible-${key}`}
                      defaultChecked={current?.visible ?? true}
                    />
                    <span>{t('admin', 'permissions.visible')}</span>
                  </label>

                  <select
                    className="sba-select"
                    id={`cap-editable-${key}`}
                    name={`cap-editable-${key}`}
                    defaultValue={current?.editableBy ?? 'admin'}
                    aria-label={t('admin', 'permissions.editableBy')}
                  >
                    <option value="admin">{t('admin', 'permissions.byAdmin')}</option>
                    <option value="merchant">{t('admin', 'permissions.byMerchant')}</option>
                  </select>
                </div>
                <div />
              </div>
            );
          })}
        </div>
      </fieldset>
    </>
  );
}

function shekels(agorot: number | undefined): string {
  return agorot === undefined ? '0' : String(agorot / 100);
}

function PlanFeatureControl({
  featureKey,
  value,
}: {
  featureKey: (typeof FEATURE_KEYS)[number];
  value: StoredFeatureValue | undefined;
}) {
  const name = `feature-${featureKey}`;

  switch (FEATURE_KINDS[featureKey]) {
    case 'boolean':
      return (
        <label className="sba-check" htmlFor={name}>
          <input id={name} type="checkbox" name={name} defaultChecked={value === true} />
          <span>{t('admin', 'account.on')}</span>
        </label>
      );

    case 'integer':
      return (
        <input
          className="sba-input"
          id={name}
          name={name}
          type="number"
          min="0"
          step="1"
          defaultValue={typeof value === 'number' ? value : 0}
          aria-label={t('admin', `features.${featureKey}`)}
        />
      );

    case 'nullableInteger':
      return (
        <>
          <input
            className="sba-input"
            id={name}
            name={name}
            type="number"
            min="0"
            step="1"
            defaultValue={typeof value === 'number' ? value : 0}
            aria-label={t('admin', `features.${featureKey}`)}
          />
          <label className="sba-check" htmlFor={`unlimited-${featureKey}`}>
            <input
              id={`unlimited-${featureKey}`}
              type="checkbox"
              name={`unlimited-${featureKey}`}
              defaultChecked={value === null}
            />
            <span>{t('admin', 'account.unlimited')}</span>
          </label>
        </>
      );

    case 'templates': {
      const allowed = Array.isArray(value) ? value : [];
      return (
        <>
          {TEMPLATE_KEYS.map((key) => (
            <label className="sba-check" key={key} htmlFor={`${name}-${key}`}>
              <input
                id={`${name}-${key}`}
                type="checkbox"
                name={name}
                value={key}
                defaultChecked={allowed.includes(key)}
              />
              <span>{TEMPLATES[key].name}</span>
            </label>
          ))}
        </>
      );
    }

    case 'colorMode':
      return (
        <select
          className="sba-select"
          id={name}
          name={name}
          defaultValue={typeof value === 'string' ? value : 'preset'}
          aria-label={t('admin', 'features.color_mode')}
        >
          <option value="preset">{t('admin', 'permissions.colorModePreset')}</option>
          <option value="custom">{t('admin', 'permissions.colorModeCustom')}</option>
        </select>
      );
  }
}
