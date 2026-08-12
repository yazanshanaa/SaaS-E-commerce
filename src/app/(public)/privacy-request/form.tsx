'use client';

import { useActionState, useEffect, useRef } from 'react';
import { submitPrivacyRequestAction } from './actions';
import { PRIVACY_REQUEST_IDLE, type PrivacyRequestState } from './state';

/**
 * The form a data subject fills in.
 *
 * IT IMPORTS NO i18n, and that is the same rule the demo form follows for the same reason:
 * `src/shared/i18n` is a static object of every namespace, so one `t()` in a `'use client'` file
 * ships the whole catalogue to somebody who has no account. Every string arrives already Arabic —
 * the labels as props from the server component, the outcome from the server action. The copy still
 * lives in `messages/ar/common.json` where the language gate can see it; only the resolution moved.
 *
 * Both identity fields are OPTIONAL in the markup and one of them is required by the schema, which
 * is deliberate: marking either `required` in HTML would tell somebody who has only a phone number
 * that they must supply an email. The refusal, when it comes, says what is actually true.
 */

export interface PrivacyRequestCopy {
  whoLegend: string;
  who: Array<{ value: string; label: string }>;
  kindLegend: string;
  kinds: Array<{ value: string; label: string }>;
  email: string;
  emailHint: string;
  phone: string;
  phoneHint: string;
  tenantRef: string;
  tenantRefHint: string;
  details: string;
  detailsHint: string;
  submit: string;
  pending: string;
  successTitle: string;
}

export function PrivacyRequestForm({ copy }: { copy: PrivacyRequestCopy }) {
  const [state, formAction, pending] = useActionState<PrivacyRequestState, FormData>(
    submitPrivacyRequestAction,
    PRIVACY_REQUEST_IDLE,
  );
  const outcome = useRef<HTMLDivElement>(null);

  /**
   * Focus follows the outcome — on success the form unmounts and takes the focused button with it,
   * dropping a keyboard user back at `<body>` with no idea whether anything happened.
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

  return (
    <form action={formAction} className="sbp-form" noValidate>
      {state.status === 'error' ? (
        <div className="sbp-notice sbp-notice--error" role="alert" tabIndex={-1} ref={outcome}>
          <strong>{state.message}</strong>
        </div>
      ) : null}

      <fieldset className="sbp-field">
        <legend className="sbp-label">{copy.whoLegend}</legend>
        {copy.who.map((option, index) => (
          <label className="sbp-choice" key={option.value}>
            <input
              type="radio"
              name="subjectKind"
              value={option.value}
              defaultChecked={
                values.subjectKind ? values.subjectKind === option.value : index === 0
              }
            />
            <span>{option.label}</span>
          </label>
        ))}
      </fieldset>

      <fieldset className="sbp-field">
        <legend className="sbp-label">{copy.kindLegend}</legend>
        {copy.kinds.map((option, index) => (
          <label className="sbp-choice" key={option.value}>
            <input
              type="radio"
              name="kind"
              value={option.value}
              defaultChecked={values.kind ? values.kind === option.value : index === 0}
            />
            <span>{option.label}</span>
          </label>
        ))}
      </fieldset>

      <div className="sbp-field">
        <label className="sbp-label" htmlFor="subjectEmail">
          {copy.email}
        </label>
        <input
          className="sbp-input"
          id="subjectEmail"
          name="subjectEmail"
          type="email"
          dir="ltr"
          maxLength={160}
          defaultValue={values.subjectEmail ?? ''}
          autoComplete="email"
          aria-describedby="subjectEmail-hint"
        />
        <span className="sbp-hint" id="subjectEmail-hint">
          {copy.emailHint}
        </span>
      </div>

      <div className="sbp-field">
        <label className="sbp-label" htmlFor="subjectPhone">
          {copy.phone}
        </label>
        {/* `dir="ltr"` on the input alone: the number is Latin-by-content inside an RTL page. */}
        <input
          className="sbp-input"
          id="subjectPhone"
          name="subjectPhone"
          type="tel"
          dir="ltr"
          inputMode="tel"
          defaultValue={values.subjectPhone ?? ''}
          autoComplete="tel"
          aria-describedby="subjectPhone-hint"
        />
        <span className="sbp-hint" id="subjectPhone-hint">
          {copy.phoneHint}
        </span>
      </div>

      <div className="sbp-field">
        <label className="sbp-label" htmlFor="tenantRef">
          {copy.tenantRef}
        </label>
        <input
          className="sbp-input"
          id="tenantRef"
          name="tenantRef"
          type="text"
          maxLength={120}
          defaultValue={values.tenantRef ?? ''}
          aria-describedby="tenantRef-hint"
        />
        <span className="sbp-hint" id="tenantRef-hint">
          {copy.tenantRefHint}
        </span>
      </div>

      <div className="sbp-field">
        <label className="sbp-label" htmlFor="details">
          {copy.details}
        </label>
        <textarea
          className="sbp-input"
          id="details"
          name="details"
          rows={5}
          required
          maxLength={2000}
          defaultValue={values.details ?? ''}
          aria-describedby="details-hint"
        />
        <span className="sbp-hint" id="details-hint">
          {copy.detailsHint}
        </span>
      </div>

      <div className="sbp-actions">
        <button type="submit" className="sbp-btn" disabled={pending}>
          {pending ? copy.pending : copy.submit}
        </button>
      </div>
    </form>
  );
}
