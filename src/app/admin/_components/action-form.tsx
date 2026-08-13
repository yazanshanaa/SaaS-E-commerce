'use client';

import { useActionState } from 'react';
import type { ActionState } from '@/server/admin/validation';
import { t } from '@/shared/i18n';
import { preserveFormValuesOnSubmit } from '@/shared/form-values';
import { resolveMessage } from './messages';

/**
 * The one client component in the panel.
 *
 * Every mutating form in A1 is wrapped in it, so validation feedback works the same way
 * everywhere: a single summary at the TOP of the form, in `role="alert"`, listing what went
 * wrong. That is deliberate rather than lazy — an error summary at the head of a form is what a
 * screen-reader user reaches first after submitting, whereas per-field messages scattered down
 * a long form are found only by hunting.
 *
 * It holds no copy of its own: the server action returns i18n keys and this resolves them.
 */

export interface ActionFormProps {
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  submitLabel: string;
  children: React.ReactNode;
  /** Rendered next to the submit button — a cancel link, usually. */
  aside?: React.ReactNode;
  className?: string;
  variant?: 'primary' | 'danger';
}

const INITIAL: ActionState = { status: 'idle' };

export function ActionForm({
  action,
  submitLabel,
  children,
  aside,
  className,
  variant = 'primary',
}: ActionFormProps) {
  const [state, formAction, pending] = useActionState(action, INITIAL);

  return (
    <form
      action={formAction}
      onSubmit={(event) => preserveFormValuesOnSubmit(event.currentTarget)}
      className={className ?? 'sba-form'}
      noValidate
    >
      {state.status === 'error' ? (
        <div className="sba-notice sba-notice--error" role="alert">
          <strong>{resolveMessage(state.messageKey)}</strong>
          {state.fieldErrors && state.fieldErrors.length > 0 ? (
            <ul>
              {state.fieldErrors.map((error) => (
                <li key={`${error.field}:${error.messageKey}`} data-field={error.field}>
                  {resolveMessage(error.messageKey)}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {state.status === 'ok' ? (
        <div className="sba-notice sba-notice--ok" role="status">
          {resolveMessage(state.messageKey)}
        </div>
      ) : null}

      {children}

      <div className="sba-actions">
        <button
          type="submit"
          className={variant === 'danger' ? 'sba-btn sba-btn--danger' : 'sba-btn sba-btn--primary'}
          disabled={pending}
        >
          {pending ? t('common', 'states.loading') : submitLabel}
        </button>
        {aside}
      </div>
    </form>
  );
}
