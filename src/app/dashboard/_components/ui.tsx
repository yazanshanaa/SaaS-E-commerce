import Link from 'next/link';
import { formatAgorot, type MessageParams } from '@/shared/i18n';
import { Sparkline } from '@/app/_components/kit/sparkline';
import { resolveMessage } from './messages';

/**
 * The dashboard's server-rendered building blocks.
 *
 * They exist so no screen writes chrome by hand — and, more importantly, so no screen writes
 * COPY by hand: every string below arrives as an i18n key or as already-translated text from a
 * page, which is what keeps the language gate mechanical rather than a matter of review
 * attention.
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
    <header className="sbd-page-head">
      <div>
        <h1 className="sbd-page-title">{title}</h1>
        {subtitle ? <p className="sbd-page-sub">{subtitle}</p> : null}
      </div>
      {actions ? <div className="sbd-actions">{actions}</div> : null}
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
  /** `locked` marks content this plan hands to the platform owner — see LockedNotice. */
  tone?: 'locked' | 'danger';
  /**
   * «مرصد» signature element #2 — the corner bloom (`kit.css`, `[data-bloom]`). At most one per
   * screen: it says "this one is why you came here", and a page where everything blooms says
   * nothing. Replaces the shadow, which is `none` in dark mode by policy.
   */
  bloom?: boolean;
}) {
  const className =
    tone === 'locked'
      ? 'sbd-panel sbd-panel--locked'
      : tone === 'danger'
        ? 'sbd-panel sbd-panel--danger'
        : 'sbd-panel';

  return (
    <section className={className} data-bloom={bloom ? 'true' : undefined}>
      {title || actions ? (
        <div className="sbd-panel-head">
          {title ? <h2 className="sbd-panel-title">{title}</h2> : <span />}
          {actions ? <div className="sbd-actions">{actions}</div> : null}
        </div>
      ) : null}
      {note ? <p className="sbd-panel-note">{note}</p> : null}
      {children}
    </section>
  );
}

/**
 * The banner a redirect-based action leaves behind.
 *
 * One-click controls do not go through `ActionForm` — they redirect back to the page — so their
 * outcome arrives as a query parameter and is resolved here through the same key vocabulary.
 *
 * Phase 9 added `params`, which is what let Track D's own `delivery/notice.tsx` be deleted rather
 * than kept: «البلدة {town} موجودة أصلاً ضمن {zone}» is the one redirect message on this surface that
 * has to name something, and without interpolation the merchant read the braces. The values are the
 * merchant's own text echoed back to them, rendered as a React child and therefore escaped; the
 * action caps their length before they reach the URL. Use `noticeKey()` to build the key so a crafted
 * link cannot choose which message appears.
 */
export function Notice({
  okKey,
  errorKey,
  params,
}: {
  okKey?: string;
  errorKey?: string;
  params?: MessageParams;
}) {
  if (errorKey) {
    return (
      <div className="sbd-notice sbd-notice--error" role="alert">
        {resolveMessage(errorKey, params)}
      </div>
    );
  }

  if (okKey) {
    return (
      <div className="sbd-notice sbd-notice--ok" role="status">
        {resolveMessage(okKey, params)}
      </div>
    );
  }

  return null;
}

/**
 * Phase 11 (Track 11.F): an empty state may NAME THE NEXT STEP and link to it. «ما في منتجات
 * بعد» with nothing under it is a dead end; the same sentence over «أضف أول منتج» is an
 * onboarding step. Additive — every existing call site keeps rendering exactly as before.
 */
export function Empty({
  children,
  actionHref,
  actionLabel,
}: {
  children: React.ReactNode;
  actionHref?: string;
  actionLabel?: string;
}) {
  return (
    <div className="sbd-empty">
      <p>{children}</p>
      {actionHref && actionLabel ? (
        <Link className="sbd-btn sbd-btn--primary sbk-empty-action" href={actionHref}>
          {actionLabel}
        </Link>
      ) : null}
    </div>
  );
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
    <div className="sbd-field">
      <label className="sbd-label" htmlFor={name}>
        {label}
      </label>
      {children}
      {hint ? <span className="sbd-hint">{hint}</span> : null}
    </div>
  );
}

export function TextInput({
  name,
  id,
  type = 'text',
  defaultValue,
  required,
  placeholder,
  readOnly,
  step,
  min,
  max,
  inputMode,
  autoComplete,
}: {
  name: string;
  id?: string;
  type?: string;
  defaultValue?: string | number;
  required?: boolean;
  placeholder?: string;
  readOnly?: boolean;
  step?: string;
  min?: string;
  max?: string;
  inputMode?: 'text' | 'numeric' | 'decimal' | 'tel' | 'email' | 'url';
  autoComplete?: string;
}) {
  return (
    <input
      className="sbd-input"
      id={id ?? name}
      name={name}
      type={type}
      defaultValue={defaultValue}
      required={required}
      placeholder={placeholder}
      readOnly={readOnly}
      step={step}
      min={min}
      max={max}
      inputMode={inputMode}
      autoComplete={autoComplete}
    />
  );
}

export function TextArea({
  name,
  id,
  defaultValue,
  rows,
  readOnly,
  required,
}: {
  name: string;
  id?: string;
  defaultValue?: string;
  rows?: number;
  readOnly?: boolean;
  required?: boolean;
}) {
  return (
    <textarea
      className="sbd-textarea"
      id={id ?? name}
      name={name}
      defaultValue={defaultValue}
      rows={rows}
      readOnly={readOnly}
      required={required}
    />
  );
}

export function Select({
  name,
  id,
  defaultValue,
  options,
  disabled,
}: {
  name: string;
  id?: string;
  defaultValue?: string;
  options: Array<{ value: string; label: string }>;
  disabled?: boolean;
}) {
  return (
    <select
      className="sbd-select"
      id={id ?? name}
      name={name}
      defaultValue={defaultValue}
      disabled={disabled}
    >
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
  disabled,
}: {
  name: string;
  label: string;
  defaultChecked?: boolean;
  hint?: string;
  value?: string;
  disabled?: boolean;
}) {
  const id = `${name}-${value}`;
  return (
    <label className="sbd-check" htmlFor={id}>
      <input
        id={id}
        type="checkbox"
        name={name}
        value={value}
        defaultChecked={defaultChecked}
        disabled={disabled}
      />
      <span>
        {label}
        {hint ? <span className="sbd-hint">{hint}</span> : null}
      </span>
    </label>
  );
}

/**
 * A state marker that says its state in WORDS.
 *
 * Not a coloured dot and never an emoji (CLAUDE.md forbids emoji as icons): a control whose only
 * difference between two states is a hue is unusable for a large share of people, and these
 * markers carry "published", "locked" and "sold out" — the three facts a merchant scans a table
 * for.
 */
export function Tag({
  label,
  tone,
}: {
  label: string;
  tone?: 'ok' | 'muted' | 'locked';
}) {
  return <span className={tone ? `sbd-tag sbd-tag--${tone}` : 'sbd-tag'}>{label}</span>;
}

export function Money({ agorot }: { agorot: number }) {
  return <span className="sbd-num">{formatAgorot(agorot)}</span>;
}

export function BackLink({ href, label }: { href: string; label: string }) {
  return (
    <Link className="sbd-btn sbd-btn--quiet" href={href}>
      {label}
    </Link>
  );
}

export function Stat({
  label,
  value,
  note,
  meterPercent,
  trend,
}: {
  label: string;
  value: string;
  note?: string;
  meterPercent?: number;
  /**
   * A REAL daily series for this metric, oldest first — «مرصد» signature element #1.
   *
   * Optional and deliberately unforgiving: a `Stat` with no series shows no line. There is no
   * placeholder, no smoothed guess and no flat stub, because a chart is a claim about what
   * happened and a decorative one is a false claim. Only screens that already compute a series
   * pass it — today that is «سلوك الزوار», whose `analytics_daily` rollup produces exactly this
   * shape (`DailyPoint[]` in `src/server/analytics/report.ts`).
   *
   * A total and its trend must come from the SAME query. Passing a series from a different
   * window than the value above it is the failure this prop is easiest to misuse for.
   */
  trend?: readonly number[];
}) {
  return (
    <div className="sbd-stat">
      <dt>{label}</dt>
      <dd>{value}</dd>
      {trend ? <Sparkline values={trend} /> : null}
      {note ? <span className="sbd-hint">{note}</span> : null}
      {typeof meterPercent === 'number' ? (
        <div
          className="sbd-meter"
          role="progressbar"
          aria-valuenow={Math.round(meterPercent)}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={label}
        >
          <span style={{ inlineSize: `${Math.min(100, Math.max(0, meterPercent))}%` }} />
        </div>
      ) : null}
    </div>
  );
}
