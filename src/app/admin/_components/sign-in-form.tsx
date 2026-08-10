'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { t } from '@/shared/i18n';

/**
 * The platform owner's sign-in, on `admin.{DOMAIN}`.
 *
 * It has to live on this hostname and not only on `app.{DOMAIN}`: session cookies are host-only
 * (`crossSubDomainCookies` is disabled so a session never follows anyone onto a storefront), so
 * a session obtained on the app host simply is not present here.
 *
 * Two factors are mandatory for the super admin, so this is a two-step form rather than one:
 * better-auth answers a correct password with `{ twoFactorRedirect: true }` and no session, and
 * the code is verified as a second call.
 *
 * The failure copy is deliberately identical for a wrong password and an unknown address — a
 * difference between the two is an account-enumeration oracle that hands out the platform's
 * customer list one guess at a time.
 */

type Step = 'credentials' | 'twoFactor';

export function SignInForm() {
  const router = useRouter();
  const [step, setStep] = useState<Step>('credentials');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function post(path: string, body: unknown): Promise<Response> {
    return fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  async function submitCredentials(form: FormData) {
    setPending(true);
    setError(null);

    try {
      const response = await post('/api/auth/sign-in/email', {
        email: String(form.get('email') ?? ''),
        password: String(form.get('password') ?? ''),
      });

      if (!response.ok) {
        setError(t('admin', 'signIn.failed'));
        return;
      }

      const payload = (await response.json()) as { twoFactorRedirect?: boolean };
      if (payload.twoFactorRedirect) {
        setStep('twoFactor');
        return;
      }

      router.refresh();
    } catch {
      setError(t('admin', 'signIn.failed'));
    } finally {
      setPending(false);
    }
  }

  async function submitTwoFactor(form: FormData) {
    setPending(true);
    setError(null);

    try {
      const response = await post('/api/auth/two-factor/verify-totp', {
        code: String(form.get('code') ?? '').trim(),
      });

      if (!response.ok) {
        setError(t('admin', 'signIn.twoFactorFailed'));
        return;
      }

      router.refresh();
    } catch {
      setError(t('admin', 'signIn.twoFactorFailed'));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="sba-auth-card">
      <h1 className="sba-auth-title">{t('admin', 'signInTitle')}</h1>
      <p className="sba-hint">
        {step === 'credentials' ? t('admin', 'signIn.intro') : t('admin', 'signIn.twoFactorIntro')}
      </p>

      {error ? (
        <div className="sba-notice sba-notice--error" role="alert">
          {error}
        </div>
      ) : null}

      {step === 'credentials' ? (
        <form className="sba-form" action={submitCredentials}>
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

          <div className="sba-field">
            <label className="sba-label" htmlFor="password">
              {t('common', 'auth.password')}
            </label>
            <input
              className="sba-input"
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
            />
          </div>

          <div className="sba-actions">
            <button type="submit" className="sba-btn sba-btn--primary" disabled={pending}>
              {pending ? t('common', 'states.loading') : t('admin', 'signIn.submit')}
            </button>
            <a className="sba-btn sba-btn--quiet" href="/forgot-password">
              {t('admin', 'signIn.forgot')}
            </a>
          </div>
        </form>
      ) : (
        <form className="sba-form" action={submitTwoFactor}>
          <div className="sba-field">
            <label className="sba-label" htmlFor="code">
              {t('common', 'auth.twoFactor')}
            </label>
            <input
              className="sba-input"
              id="code"
              name="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              required
            />
            <span className="sba-hint">{t('common', 'auth.twoFactorHint')}</span>
          </div>

          <div className="sba-actions">
            <button type="submit" className="sba-btn sba-btn--primary" disabled={pending}>
              {pending ? t('common', 'states.loading') : t('admin', 'signIn.verify')}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
