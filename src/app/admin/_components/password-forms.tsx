'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { t } from '@/shared/i18n';

/**
 * Password recovery for the PLATFORM OWNER, on the admin host.
 *
 * It exists because the alternative is a locked-out platform owner and a database console. The
 * merchant-facing equivalents live on `app.{DOMAIN}` and belong to B2 — sessions are host-only,
 * so each surface needs its own door.
 *
 * The confirmation for a reset request is deliberately unconditional: it says a link was sent if
 * the address is registered, and says exactly that whether or not it is. Anything else answers
 * "does this person have an account here" for anyone who asks.
 */

async function postJson(path: string, body: unknown): Promise<Response> {
  return fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export function ForgotPasswordForm() {
  const [pending, setPending] = useState(false);
  const [sent, setSent] = useState(false);

  async function submit(form: FormData) {
    setPending(true);
    try {
      await postJson('/api/auth/request-password-reset', {
        email: String(form.get('email') ?? ''),
        redirectTo: `${window.location.origin}/reset-password`,
      });
    } finally {
      setSent(true);
      setPending(false);
    }
  }

  return (
    <div className="sba-auth-card">
      <h1 className="sba-auth-title">{t('common', 'auth.resetPassword')}</h1>

      {sent ? (
        <div className="sba-notice sba-notice--ok" role="status">
          {t('common', 'auth.resetSent')}
        </div>
      ) : (
        <>
          <p className="sba-hint">{t('admin', 'signIn.resetIntro')}</p>
          <form className="sba-form" action={submit}>
            <div className="sba-field">
              <label className="sba-label" htmlFor="email">
                {t('common', 'auth.email')}
              </label>
              <input
                className="sba-input"
                id="email"
                name="email"
                type="email"
                autoComplete="username"
                required
              />
            </div>
            <div className="sba-actions">
              <button type="submit" className="sba-btn sba-btn--primary" disabled={pending}>
                {pending ? t('common', 'states.loading') : t('admin', 'signIn.sendReset')}
              </button>
              <a className="sba-btn sba-btn--quiet" href="/">
                {t('admin', 'signIn.backToSignIn')}
              </a>
            </div>
          </form>
        </>
      )}
    </div>
  );
}

export function ResetPasswordForm({ token }: { token: string | null }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function submit(form: FormData) {
    const password = String(form.get('password') ?? '');
    const confirmation = String(form.get('confirmPassword') ?? '');

    if (password.length < 10) {
      setError(t('admin', 'signIn.passwordTooShort'));
      return;
    }
    if (password !== confirmation) {
      setError(t('admin', 'signIn.passwordMismatch'));
      return;
    }

    setPending(true);
    setError(null);

    try {
      const response = await postJson('/api/auth/reset-password', {
        newPassword: password,
        token,
      });

      if (!response.ok) {
        setError(t('common', 'auth.linkExpired'));
        return;
      }

      setDone(true);
      router.refresh();
    } catch {
      setError(t('common', 'errors.server.body'));
    } finally {
      setPending(false);
    }
  }

  if (!token) {
    return (
      <div className="sba-auth-card">
        <h1 className="sba-auth-title">{t('common', 'auth.resetPassword')}</h1>
        <div className="sba-notice sba-notice--error" role="alert">
          {t('admin', 'signIn.missingToken')}
        </div>
        <a className="sba-btn" href="/forgot-password">
          {t('admin', 'signIn.sendReset')}
        </a>
      </div>
    );
  }

  return (
    <div className="sba-auth-card">
      <h1 className="sba-auth-title">{t('common', 'auth.resetPassword')}</h1>

      {done ? (
        <>
          <div className="sba-notice sba-notice--ok" role="status">
            {t('common', 'auth.resetDone')}
          </div>
          <a className="sba-btn sba-btn--primary" href="/">
            {t('common', 'auth.signIn')}
          </a>
        </>
      ) : (
        <>
          {error ? (
            <div className="sba-notice sba-notice--error" role="alert">
              {error}
            </div>
          ) : null}

          <form className="sba-form" action={submit}>
            <div className="sba-field">
              <label className="sba-label" htmlFor="password">
                {t('common', 'auth.newPassword')}
              </label>
              <input
                className="sba-input"
                id="password"
                name="password"
                type="password"
                autoComplete="new-password"
                required
              />
            </div>

            <div className="sba-field">
              <label className="sba-label" htmlFor="confirmPassword">
                {t('common', 'auth.confirmPassword')}
              </label>
              <input
                className="sba-input"
                id="confirmPassword"
                name="confirmPassword"
                type="password"
                autoComplete="new-password"
                required
              />
            </div>

            <div className="sba-actions">
              <button type="submit" className="sba-btn sba-btn--primary" disabled={pending}>
                {pending ? t('common', 'states.loading') : t('admin', 'signIn.setNewPassword')}
              </button>
            </div>
          </form>
        </>
      )}
    </div>
  );
}
