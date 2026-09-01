import Link from 'next/link';
import { formatAgorot } from '@/shared/i18n';
import { resolveMessage } from './messages';

/**
 * The panel's server-rendered building blocks.
 *
 * They exist so no screen writes chrome by hand — and, more importantly, so no screen writes
 * COPY by hand: every string below arrives as an i18n key or as already-translated text from a
 * page, which is what keeps the language gate mechanical.
 */

export function PageHead({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: string;
  actions?: React.ReactNode;
}) {
  return (
    <header className="sba-page-head">
      <div>
        <h1 className="sba-page-title">{title}</h1>
        {subtitle ? <p className="sba-page-sub">{subtitle}</p> : null}
      </div>
      {actions ? <div className="sba-page-actions">{actions}</div> : null}
    </header>
  );
}

export function Panel({
  title,
  note,
  actions,
  children,
  tone,
  bloom,
}: {
  title?: string;
  note?: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
  tone?: 'danger';
  /**
   * «مرصد» signature element #2 — the corner bloom (`kit.css`, `[data-bloom]`).
   *
   * A single radial wash of the accent in the block-start / inline-end corner. It replaces the
   * drop shadow, which is `none` in dark mode by policy — a shadow on a dark panel is a smudge,
   * not a lift.
   *
   * AT MOST ONE PER SCREEN. Its only job is to say "this one is why you came here", and a page
   * where every panel blooms says nothing at all. If a second panel wants it, the first one
   * probably was not the primary.
   */
  bloom?: boolean;
}) {
  return (
    <section
      className={tone === 'danger' ? 'sba-panel sba-panel--danger' : 'sba-panel'}
      data-bloom={bloom ? 'true' : undefined}
    >
      {title || actions ? (
        <div className="sba-panel-head">
          {title ? <h2 className="sba-panel-title">{title}</h2> : <span />}
          {actions ? <div className="sba-actions">{actions}</div> : null}
        </div>
      ) : null}
      {note ? <p className="sba-panel-note">{note}</p> : null}
      {children}
    </section>
  );
}

/**
 * The banner a redirect-based action leaves behind.
 *
 * One-click toggles do not go through `ActionForm` — they redirect back to the page — so their
 * outcome arrives as a query parameter and is resolved here through the same key vocabulary.
 */
export function Notice({ okKey, errorKey }: { okKey?: string; errorKey?: string }) {
  if (errorKey) {
    return (
      <div className="sba-notice sba-notice--error" role="alert">
        {resolveMessage(errorKey)}
      </div>
    );
  }

  if (okKey) {
    return (
      <div className="sba-notice sba-notice--ok" role="status">
        {resolveMessage(okKey)}
      </div>
    );
  }

  return null;
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <p className="sba-empty">{children}</p>;
}

export function Field({
  label,
  name,
  hint,
  children,
}: {
  label: string;
  name: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="sba-field">
      <label className="sba-label" htmlFor={name}>
        {label}
      </label>
      {children}
      {hint ? <span className="sba-hint">{hint}</span> : null}
    </div>
  );
}

export function TextInput({
  name,
  type = 'text',
  defaultValue,
  required,
  placeholder,
  step,
  min,
  max,
}: {
  name: string;
  type?: string;
  defaultValue?: string | number;
  required?: boolean;
  placeholder?: string;
  step?: string;
  min?: string;
  max?: string;
}) {
  return (
    <input
      className="sba-input"
      id={name}
      name={name}
      type={type}
      defaultValue={defaultValue}
      required={required}
      placeholder={placeholder}
      step={step}
      min={min}
      max={max}
    />
  );
}

export function Select({
  name,
  defaultValue,
  options,
}: {
  name: string;
  defaultValue?: string;
  options: Array<{ value: string; label: string }>;
}) {
  return (
    <select className="sba-select" id={name} name={name} defaultValue={defaultValue}>
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

export function Checkbox({
  name,
  label,
  defaultChecked,
  hint,
  value = 'on',
}: {
  name: string;
  label: string;
  defaultChecked?: boolean;
  hint?: string;
  value?: string;
}) {
  const id = `${name}-${value}`;
  return (
    <label className="sba-check" htmlFor={id}>
      <input id={id} type="checkbox" name={name} value={value} defaultChecked={defaultChecked} />
      <span>
        {label}
        {hint ? <span className="sba-hint">{hint}</span> : null}
      </span>
    </label>
  );
}

/**
 * A one-click switch: a submit button inside its own tiny form.
 *
 * `aria-pressed` carries the state, and the visible label changes with it — a control whose only
 * difference between on and off is a colour is unusable for a large share of people, and this
 * one is used to grant and revoke access.
 */
export function SwitchButton({
  pressed,
  label,
  name = 'value',
}: {
  pressed: boolean;
  label: string;
  name?: string;
}) {
  return (
    <>
      <input type="hidden" name={name} value={pressed ? 'off' : 'on'} />
      <button type="submit" className="sba-switch" aria-pressed={pressed}>
        <span className="sba-switch-track" aria-hidden="true" />
        <span className="sba-switch-label">{label}</span>
      </button>
    </>
  );
}

export function StatusTag({ status, label }: { status: string; label: string }) {
  return <span className={`sba-status sba-status--${status}`}>{label}</span>;
}

export function Money({ agorot }: { agorot: number }) {
  return <span className="sba-num">{formatAgorot(agorot)}</span>;
}

export function BackLink({ href, label }: { href: string; label: string }) {
  return (
    <Link className="sba-btn sba-btn--quiet" href={href}>
      {label}
    </Link>
  );
}
