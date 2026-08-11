'use client';

import { useActionState } from 'react';
import { t } from '@/shared/i18n';
import type { ActionState } from '../_lib/validation';
import { resolveFieldError, resolveMessage } from './messages';

/**
 * Every mutating form on this surface.
 *
 * Validation feedback works the same way everywhere: a single summary at the TOP of the form,
 * in `role="alert"`, listing what went wrong. That is deliberate rather than lazy — an error
 * summary at the head of a form is what a screen-reader user reaches first after submitting,
 * whereas per-field messages scattered down a long form are found only by hunting.
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
  variant?: 'primary' | 'danger' | 'plain';
  /** Disables submission without hiding the form — the exhausted change-request quota. */
  disabled?: boolean;
}

const INITIAL: ActionState = { status: 'idle' };

export function ActionForm({
  action,
  submitLabel,
  children,
  aside,
  className,
  variant = 'primary',
  disabled,
}: ActionFormProps) {
  const [state, formAction, pending] = useActionState(action, INITIAL);

  const buttonClass =
    variant === 'danger'
      ? 'sbd-btn sbd-btn--danger'
      : variant === 'plain'
        ? 'sbd-btn'
        : 'sbd-btn sbd-btn--primary';

  return (
    <form action={formAction} className={className ?? 'sbd-form'} noValidate>
      {state.status === 'error' ? (
        <div className="sbd-notice sbd-notice--error" role="alert">
          <strong>{resolveMessage(state.messageKey)}</strong>
          {state.fieldErrors && state.fieldErrors.length > 0 ? (
            <ul>
              {state.fieldErrors.map((error) => (
                <li key={`${error.field}:${error.messageKey}`} data-field={error.field}>
                  {resolveFieldError(error)}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {state.status === 'ok' ? (
        <div className="sbd-notice sbd-notice--ok" role="status">
          {resolveMessage(state.messageKey)}
        </div>
      ) : null}

      {children}

      <div className="sbd-actions">
        <button type="submit" className={buttonClass} disabled={pending || disabled}>
          {pending ? t('common', 'states.loading') : submitLabel}
        </button>
        {aside}
      </div>
    </form>
  );
}
