'use client';

import { useActionState, useEffect, useRef, useState } from 'react';
import { submitDemoRequestAction } from './actions';
import { DEMO_REQUEST_IDLE, type DemoRequestState } from './state';

/**
 * The form a prospect fills in.
 *
 * It is the only client component on the public surface, and it exists for two reasons a
 * server-rendered form could not cover:
 *
 *   1. VALIDATION FEEDBACK WITHOUT A REDIRECT. The alternative — an action that redirects with the
 *      outcome in the query string, which is how A1's one-click toggles work — would either lose
 *      everything the person typed or put their address and phone number in a URL, and from there
 *      into browser history and every access log on the way. Neither is acceptable for this form.
 *   2. The live link preview under the prefix box, which is what makes the field's purpose obvious
 *      without a paragraph explaining it.
 *
 * IT IMPORTS NO i18n, AND THAT IS THE POINT. `src/shared/i18n` is a static object holding all seven
 * namespace files, so one `t()` here would ship the admin panel's entire message catalogue to a
 * prospect on a phone. Every string arrives already Arabic: the labels as props from the server
 * component, the outcome from the server action. The copy still lives in `messages/ar/demo.json`
 * where the language gate can see it — only the resolution moved.
 *
 * The error summary sits at the TOP, in `role="alert"`, listing every field that failed — the same
 * shape A1's `ActionForm` uses and for the same accessibility reason: a summary at the head of a
 * form is what a screen-reader user reaches after submitting, where per-field messages scattered
 * down the page are found only by hunting.
 */

export interface DemoRequestCopy {
  businessName: string;
  businessNameHint: string;
  address: string;
  addressHint: string;
  whatsapp: string;
  whatsappHint: string;
  prefix: string;
  prefixHint: string;
  prefixHelp: string;
  pack: string;
  packHint: string;
  packNone: string;
  submit: string;
  pending: string;
  successTitle: string;
  noticeTitle: string;
  retentionNotice: string;
}

export interface DemoRequestFormProps {
  copy: DemoRequestCopy;
  packs: Array<{ value: string; label: string }>;
  /** `.{DOMAIN}` — read from env by the page, never hardcoded. */
  hostSuffix: string;
}

function errorFor(state: DemoRequestState, field: string): boolean {
  return state.fieldErrors?.some((error) => error.field === field) ?? false;
}

/**
 * `aria-describedby` for one field: its hint, plus its error in the summary when it has one.
 *
 * The summary at the top is what a screen-reader user reaches first after submitting, but somebody
 * who then tabs INTO a field would otherwise hear only the hint and no reason it was rejected. Both
 * ids, in that order, is the shape WCAG 3.3.1 and 3.3.3 ask for together.
 */
function describedBy(state: DemoRequestState, field: string): string {
  const hint = `${field}-hint`;
  return errorFor(state, field) ? `${hint} ${field}-error` : hint;
}

export function DemoRequestForm({ copy, packs, hostSuffix }: DemoRequestFormProps) {
  const [state, formAction, pending] = useActionState<DemoRequestState, FormData>(
    submitDemoRequestAction,
    DEMO_REQUEST_IDLE,
  );
  const [prefix, setPrefix] = useState('');
  const outcome = useRef<HTMLDivElement>(null);

  /**
   * MOVE FOCUS TO THE OUTCOME, because the thing that had focus no longer exists.
   *
   * On success the whole form unmounts and the submit button goes with it, dropping focus to
   * `<body>` — a sighted keyboard user lands back at the top of the document with no idea anything
   * happened, and a screen-reader user hears a `role="status"` announcement about a page they have
   * been silently moved off. On failure the summary is inserted above a form that still exists, and
   * focusing it is what puts the reason first. `tabIndex={-1}` makes an element focusable
   * programmatically without adding it to the tab order.
   */
  useEffect(() => {
    if (state.status !== 'idle') outcome.current?.focus();
  }, [state]);

  if (state.status === 'ok') {
    return (
      <div className="sbp-card" role="status" tabIndex={-1} ref={outcome}>
        <h2 className="sbp-title">{copy.successTitle}</h2>
        <p className="sbp-lead">{state.message}</p>
      </div>
    );
  }

  const values = state.values ?? {};
  // The hint is built here rather than interpolated on the server: it changes as the box is typed
  // into, which is the whole reason the field needs no paragraph of explanation.
  const typedPrefix = (prefix || values.requestedPrefix || '').trim();
  const example = copy.prefixHint.replace('{example}', `${typedPrefix || '…'}${hostSuffix}`);

  return (
    <form action={formAction} className="sbp-form" noValidate>
      {state.status === 'error' ? (
        <div className="sbp-notice sbp-notice--error" role="alert" tabIndex={-1} ref={outcome}>
          <strong>{state.message}</strong>
          {state.fieldErrors && state.fieldErrors.length > 0 ? (
            <ul>
              {state.fieldErrors.map((error) => (
                // The id is what each field's `aria-describedby` points back at.
                <li key={error.field} id={`${error.field}-error`} data-field={error.field}>
                  {error.message}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      <div className="sbp-field">
        <label className="sbp-label" htmlFor="businessName">
          {copy.businessName}
        </label>
        <input
          className="sbp-input"
          id="businessName"
          name="businessName"
          type="text"
          maxLength={100}
          defaultValue={values.businessName ?? ''}
          autoComplete="organization"
          aria-describedby={describedBy(state, 'businessName')}
          aria-invalid={errorFor(state, 'businessName') ? true : undefined}
        />
        <span className="sbp-hint" id="businessName-hint">
          {copy.businessNameHint}
        </span>
      </div>

      <div className="sbp-field">
        <label className="sbp-label" htmlFor="address">
          {copy.address}
        </label>
        <input
          className="sbp-input"
          id="address"
          name="address"
          type="text"
          required
          maxLength={200}
          defaultValue={values.address ?? ''}
          autoComplete="street-address"
          aria-describedby={describedBy(state, 'address')}
          aria-invalid={errorFor(state, 'address') ? true : undefined}
        />
        <span className="sbp-hint" id="address-hint">
          {copy.addressHint}
        </span>
      </div>

      <div className="sbp-field">
        <label className="sbp-label" htmlFor="whatsapp">
          {copy.whatsapp}
        </label>
        {/* `dir="ltr"` on the input alone: the number is Latin-by-content inside an RTL page. */}
        <input
          className="sbp-input"
          id="whatsapp"
          name="whatsapp"
          type="tel"
          required
          dir="ltr"
          inputMode="tel"
          defaultValue={values.whatsapp ?? ''}
          autoComplete="tel"
          aria-describedby={describedBy(state, 'whatsapp')}
          aria-invalid={errorFor(state, 'whatsapp') ? true : undefined}
        />
        <span className="sbp-hint" id="whatsapp-hint">
          {copy.whatsappHint}
        </span>
      </div>

      <div className="sbp-field">
        <label className="sbp-label" htmlFor="requestedPrefix">
          {copy.prefix}
        </label>
        <input
          className="sbp-input"
          id="requestedPrefix"
          name="requestedPrefix"
          type="text"
          required
          dir="ltr"
          minLength={3}
          maxLength={40}
          defaultValue={values.requestedPrefix ?? ''}
          onChange={(event) => setPrefix(event.target.value)}
          autoComplete="off"
          aria-describedby={`requestedPrefix-hint prefix-help${
            errorFor(state, 'requestedPrefix') ? ' requestedPrefix-error' : ''
          }`}
          aria-invalid={errorFor(state, 'requestedPrefix') ? true : undefined}
        />
        <span className="sbp-hint" id="requestedPrefix-hint">
          {example}
        </span>
        <span className="sbp-hint" id="prefix-help">
          {copy.prefixHelp}
        </span>
      </div>

      <div className="sbp-field">
        <label className="sbp-label" htmlFor="packKey">
          {copy.pack}
        </label>
        <select
          className="sbp-select"
          id="packKey"
          name="packKey"
          defaultValue={values.packKey ?? ''}
          aria-describedby={describedBy(state, 'packKey')}
          aria-invalid={errorFor(state, 'packKey') ? true : undefined}
        >
          <option value="">{copy.packNone}</option>
          {packs.map((pack) => (
            <option key={pack.value} value={pack.value}>
              {pack.label}
            </option>
          ))}
        </select>
        <span className="sbp-hint" id="packKey-hint">
          {copy.packHint}
        </span>
      </div>

      {/*
        The retention notice sits ABOVE the button, not in a footer.
        It is the sentence that makes the form lawful to submit, and it has to be read before the
        decision to submit rather than after it.
      */}
      <section className="sbp-notice" aria-labelledby="notice-title">
        <h2 className="sbp-notice-title" id="notice-title">
          {copy.noticeTitle}
        </h2>
        <p>{copy.retentionNotice}</p>
      </section>

      <div className="sbp-actions">
        <button type="submit" className="sbp-btn" disabled={pending}>
          {pending ? copy.pending : copy.submit}
        </button>
      </div>
    </form>
  );
}
