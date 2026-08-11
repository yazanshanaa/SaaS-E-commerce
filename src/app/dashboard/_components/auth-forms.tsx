'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { t } from '@/shared/i18n';

/**
 * The merchant's own doors: sign in, ask for a reset link, set a new password.
 *
 * They have to live on `app.{DOMAIN}` and not only on the admin host, because session cookies
 * are host-only (`crossSubDomainCookies` is disabled so a session never follows a visitor onto a
 * merchant's storefront) — a session obtained on `admin.{DOMAIN}` simply is not present here.
 * A1 ships the platform owner's equivalents and says the same thing from the other side.
 *
 * `/reset-password` is not optional decoration either: it is the `redirectTo` that A1's owner
 * invitation and this track's staff invitation both send, so without this page every account
 * ever created would receive a working link to a 404.
 *
 * Two failure messages are deliberately identical for a wrong password and an unknown address,
 * and the reset confirmation is unconditional. Anything else answers "does this person have a
 * shop here" for anyone who asks, one guess at a time.
 */

type Step = 'credentials' | 'twoFactor';

async function postJson(path: string, body: unknown): Promise<Response> {
  return fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export function MerchantSignInForm({ noMembership }: { noMembership?: boolean }) {
  const router = useRouter();
  const [step, setStep] = useState<Step>('credentials');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submitCredentials(form: FormData) {
    setPending(true);
    setError(null);

    try {
      const response = await postJson('/api/auth/sign-in/email', {
        email: String(form.get('email') ?? ''),
        password: String(form.get('password') ?? ''),
      });

      if (!response.ok) {
        setError(t('dashboard', 'signIn.failed'));
        return;
      }

      const payload = (await response.json()) as { twoFactorRedirect?: boolean };
      if (payload.twoFactorRedirect) {
        setStep('twoFactor');
        return;
      }

      router.refresh();
    } catch {
      setError(t('dashboard', 'signIn.failed'));
    } finally {
      setPending(false);
    }
  }

  async function submitTwoFactor(form: FormData) {
    setPending(true);
    setError(null);

    try {
      const response = await postJson('/api/auth/two-factor/verify-totp', {
        code: String(form.get('code') ?? '').trim(),
      });

      if (!response.ok) {
        setError(t('dashboard', 'signIn.twoFactorFailed'));
        return;
      }

      router.refresh();
    } catch {
      setError(t('dashboard', 'signIn.twoFactorFailed'));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="sbd-auth-card">
      <h1 className="sbd-auth-title">{t('dashboard', 'signInTitle')}</h1>
      <p className="sbd-hint">
        {step === 'credentials'
          ? t('dashboard', 'signIn.intro')
          : t('dashboard', 'signIn.twoFactorIntro')}
      </p>

      {/*
        A signed-in user with no membership is a real state, not an error: a super admin who
        opened app.* without impersonating anyone, or someone whose membership was removed while
        they were away. Saying so beats a sign-in form that appears to do nothing when used.
      */}
      {noMembership ? (
        <div className="sbd-notice sbd-notice--info" role="status">
          {t('dashboard', 'signIn.noMembership')}
        </div>
      ) : null}

      {error ? (
        <div className="sbd-notice sbd-notice--error" role="alert">
          {error}
        </div>
      ) : null}

      {step === 'credentials' ? (
        <form className="sbd-form" action={submitCredentials}>
          <div className="sbd-field">
            <label className="sbd-label" htmlFor="email">
              {t('common', 'auth.email')}
            </label>
            <input
              className="sbd-input"
              id="email"
              name="email"
              type="email"
              autoComplete="username"
              required
            />
          </div>

          <div className="sbd-field">
            <label className="sbd-label" htmlFor="password">
              {t('common', 'auth.password')}
            </label>
            <input
              className="sbd-input"
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
            />
          </div>

          <div className="sbd-actions">
            <button type="submit" className="sbd-btn sbd-btn--primary" disabled={pending}>
              {pending ? t('common', 'states.loading') : t('dashboard', 'signIn.submit')}
            </button>
            <a className="sbd-btn sbd-btn--quiet" href="/forgot-password">
              {t('common', 'auth.forgotPassword')}
            </a>
          </div>
        </form>
      ) : (
        <form className="sbd-form" action={submitTwoFactor}>
          <div className="sbd-field">
            <label className="sbd-label" htmlFor="code">
              {t('common', 'auth.twoFactor')}
            </label>
            <input
              className="sbd-input"
              id="code"
              name="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              required
            />
            <span className="sbd-hint">{t('common', 'auth.twoFactorHint')}</span>
          </div>

          <div className="sbd-actions">
            <button type="submit" className="sbd-btn sbd-btn--primary" disabled={pending}>
              {pending ? t('common', 'states.loading') : t('dashboard', 'signIn.verify')}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

export function MerchantForgotPasswordForm() {
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
      // Unconditional: the confirmation must not differ between a known and an unknown address.
      setSent(true);
      setPending(false);
    }
  }

  return (
    <div className="sbd-auth-card">
      <h1 className="sbd-auth-title">{t('common', 'auth.resetPassword')}</h1>

      {sent ? (
        <div className="sbd-notice sbd-notice--ok" role="status">
          {t('common', 'auth.resetSent')}
        </div>
      ) : (
        <>
          <p className="sbd-hint">{t('dashboard', 'signIn.resetIntro')}</p>
          <form className="sbd-form" action={submit}>
            <div className="sbd-field">
              <label className="sbd-label" htmlFor="email">
                {t('common', 'auth.email')}
              </label>
              <input
                className="sbd-input"
                id="email"
                name="email"
                type="email"
                autoComplete="username"
                required
              />
            </div>
            <div className="sbd-actions">
              <button type="submit" className="sbd-btn sbd-btn--primary" disabled={pending}>
                {pending ? t('common', 'states.loading') : t('dashboard', 'signIn.sendReset')}
              </button>
              <a className="sbd-btn sbd-btn--quiet" href="/">
                {t('dashboard', 'signIn.backToSignIn')}
              </a>
            </div>
          </form>
        </>
      )}
    </div>
  );
}

export function MerchantResetPasswordForm({ token }: { token: string | null }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function submit(form: FormData) {
    const password = String(form.get('password') ?? '');
    const confirmation = String(form.get('confirmPassword') ?? '');

    // Checked here as well as by better-auth's `minPasswordLength`, because the library's
    // refusal is an English message from a validation library and this one is the merchant's.
    if (password.length < 10) {
      setError(t('dashboard', 'signIn.passwordTooShort'));
      return;
    }
    if (password !== confirmation) {
      setError(t('dashboard', 'signIn.passwordMismatch'));
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
      <div className="sbd-auth-card">
        <h1 className="sbd-auth-title">{t('common', 'auth.resetPassword')}</h1>
        <div className="sbd-notice sbd-notice--error" role="alert">
          {t('dashboard', 'signIn.missingToken')}
        </div>
        <a className="sbd-btn" href="/forgot-password">
          {t('dashboard', 'signIn.sendReset')}
        </a>
      </div>
    );
  }

  return (
    <div className="sbd-auth-card">
      <h1 className="sbd-auth-title">{t('common', 'auth.resetPassword')}</h1>

      {done ? (
        <>
          <div className="sbd-notice sbd-notice--ok" role="status">
            {t('common', 'auth.resetDone')}
          </div>
          <a className="sbd-btn sbd-btn--primary" href="/">
            {t('common', 'auth.signIn')}
          </a>
        </>
      ) : (
        <>
          {error ? (
            <div className="sbd-notice sbd-notice--error" role="alert">
              {error}
            </div>
          ) : null}

          <form className="sbd-form" action={submit}>
            <div className="sbd-field">
              <label className="sbd-label" htmlFor="password">
                {t('common', 'auth.newPassword')}
              </label>
              <input
                className="sbd-input"
                id="password"
                name="password"
                type="password"
                autoComplete="new-password"
                required
              />
            </div>

            <div className="sbd-field">
              <label className="sbd-label" htmlFor="confirmPassword">
                {t('common', 'auth.confirmPassword')}
              </label>
              <input
                className="sbd-input"
                id="confirmPassword"
                name="confirmPassword"
                type="password"
                autoComplete="new-password"
                required
              />
            </div>

            <div className="sbd-actions">
              <button type="submit" className="sbd-btn sbd-btn--primary" disabled={pending}>
                {pending ? t('common', 'states.loading') : t('dashboard', 'signIn.setNewPassword')}
              </button>
            </div>
          </form>
        </>
      )}
    </div>
  );
}
