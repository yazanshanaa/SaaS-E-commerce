import { t } from '@/shared/i18n';
import type { SectionType } from '../_lib/sections';
import { ActionForm } from '../_components/action-form';
import { Checkbox, Field, Select, TextArea, TextInput } from '../_components/ui';
import { saveSectionConfigAction } from './actions';

/**
 * The per-section settings form, derived from ONE table.
 *
 * The shapes themselves live in `src/shared/site-contract` and are the only authority on what a
 * section accepts; this table says how each of those fields is ASKED for. Keeping the two apart
 * is what lets the schema stay the single validator — the form can be wrong about a label and
 * still cannot be wrong about a type, because the server re-parses through the schema and stores
 * the normalised result.
 *
 * A field that a template renders but nobody can usefully type — `imageMediaId`, `mediaIds` —
 * is deliberately absent: an image is chosen from the library, not pasted as an id, and a text
 * box asking a merchant for a database identifier is worse than no control at all. Those stay
 * as A1 or B3 set them until a picker exists for them.
 */

type FieldKind = 'text' | 'textarea' | 'number' | 'boolean' | 'select';

interface ConfigField {
  name: string;
  kind: FieldKind;
  labelKey: string;
  options?: Array<{ value: string; labelKey: string }>;
}

const TEXT = (name: string, labelKey: string): ConfigField => ({ name, kind: 'text', labelKey });
const NUMBER = (name: string, labelKey: string): ConfigField => ({ name, kind: 'number', labelKey });

const COLUMNS: ConfigField = {
  name: 'columns',
  kind: 'select',
  labelKey: 'columns',
  options: [
    { value: '2', labelKey: 'columns' },
    { value: '3', labelKey: 'columns' },
    { value: '4', labelKey: 'columns' },
  ],
};

export const SECTION_FIELDS: Record<SectionType, ConfigField[]> = {
  hero: [
    TEXT('title', 'title'),
    TEXT('subtitle', 'subtitle'),
    TEXT('ctaLabel', 'ctaLabel'),
    TEXT('ctaHref', 'ctaHref'),
    {
      name: 'align',
      kind: 'select',
      labelKey: 'align',
      options: [
        { value: 'start', labelKey: 'alignStart' },
        { value: 'center', labelKey: 'alignCenter' },
      ],
    },
  ],
  products_grid: [
    TEXT('title', 'title'),
    TEXT('categoryKey', 'categoryKey'),
    NUMBER('limit', 'limit'),
    COLUMNS,
    { name: 'showPrices', kind: 'boolean', labelKey: 'showPrices' },
  ],
  categories: [
    TEXT('title', 'title'),
    NUMBER('limit', 'limit'),
    {
      name: 'style',
      kind: 'select',
      labelKey: 'style',
      options: [
        { value: 'grid', labelKey: 'styleGrid' },
        { value: 'chips', labelKey: 'styleChips' },
      ],
    },
  ],
  about: [TEXT('title', 'title'), { name: 'body', kind: 'textarea', labelKey: 'body' }],
  gallery: [TEXT('title', 'title'), COLUMNS],
  testimonials: [TEXT('title', 'title'), NUMBER('limit', 'limit')],
  announcements: [TEXT('title', 'title'), NUMBER('limit', 'limit')],
  contact_whatsapp: [
    TEXT('title', 'title'),
    { name: 'body', kind: 'textarea', labelKey: 'body' },
    TEXT('buttonLabel', 'buttonLabel'),
  ],
  map: [TEXT('title', 'title'), TEXT('query', 'query'), NUMBER('zoom', 'zoom')],
  custom_html: [{ name: 'html', kind: 'textarea', labelKey: 'html' }],
};

export function SectionConfigForm({
  sectionId,
  type,
  config,
  disabled,
}: {
  sectionId: string;
  type: SectionType;
  config: Record<string, unknown>;
  disabled?: boolean;
}) {
  const fields = SECTION_FIELDS[type];
  const booleans = fields.filter((field) => field.kind === 'boolean').map((field) => field.name);
  const numbers = fields.filter((field) => field.kind === 'number').map((field) => field.name);

  return (
    <ActionForm
      action={saveSectionConfigAction}
      submitLabel={t('common', 'actions.save')}
      disabled={disabled}
      variant="plain"
    >
      <input type="hidden" name="sectionId" value={sectionId} />
      {/*
        A checkbox that is off sends nothing at all, and zod refuses "12" for a number — so the
        action is told which names to read by presence and which to coerce. Deriving it from the
        same table the fields come from means the two can never disagree.
      */}
      <input type="hidden" name="booleans" value={booleans.join(',')} />
      <input type="hidden" name="numbers" value={numbers.join(',')} />

      <div className="sbd-grid">
        {fields.map((field) => {
          const name = `config.${field.name}`;
          const value = config[field.name];
          const label = t('dashboard', `sections.config.${field.labelKey}`);

          if (field.kind === 'boolean') {
            return (
              <Checkbox
                key={field.name}
                name={name}
                label={label}
                defaultChecked={value === true}
                disabled={disabled}
              />
            );
          }

          if (field.kind === 'select') {
            return (
              <Field key={field.name} label={label} name={name}>
                <Select
                  name={name}
                  defaultValue={value === undefined || value === null ? undefined : String(value)}
                  disabled={disabled}
                  options={(field.options ?? []).map((option) => ({
                    value: option.value,
                    // A numeric option labels itself — "2", "3", "4" — and a word one reads its
                    // own key. Both go through the i18n layer; neither is written here.
                    label: /^\d+$/.test(option.value)
                      ? option.value
                      : t('dashboard', `sections.config.${option.labelKey}`),
                  }))}
                />
              </Field>
            );
          }

          if (field.kind === 'textarea') {
            return (
              <Field key={field.name} label={label} name={name}>
                <TextArea
                  name={name}
                  defaultValue={value === undefined || value === null ? '' : String(value)}
                  readOnly={disabled}
                  rows={5}
                />
              </Field>
            );
          }

          return (
            <Field key={field.name} label={label} name={name}>
              <TextInput
                name={name}
                defaultValue={value === undefined || value === null ? '' : String(value)}
                readOnly={disabled}
                inputMode={field.kind === 'number' ? 'numeric' : undefined}
              />
            </Field>
          );
        })}
      </div>
    </ActionForm>
  );
}
