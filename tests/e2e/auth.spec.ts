import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { E2E, mailFile, origin } from './support/env';
import { decodeMessage, linksIn } from './support/smtp-sink';
import { browserFetch } from './support/http';

/**
 * Sign-in, password reset and the absence of self-registration — over HTTP, against the real
 * auth stack, with a real SMTP conversation.
 *
 * Requests are issued FROM the page so they carry the browser's resolver and its cookie jar:
 * a session cookie has to land where a subsequent navigation will look for it, which is the
 * part a Node-side HTTP client would quietly not test.
 */

function capturedMail(): string[] {
  try {
    return JSON.parse(readFileSync(mailFile, 'utf8')) as string[];
  } catch {
    return [];
  }
}

async function waitForMail(
  matching: (decoded: string) => boolean,
  timeoutMs = 20_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    for (const raw of capturedMail()) {
      const decoded = decodeMessage(raw);
      if (matching(decoded)) return decoded;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  throw new Error('No matching email arrived within the timeout.');
}

async function onAppSurface(page: Page): Promise<void> {
  await page.goto(`${origin('app')}/`);
}

test.describe('sign-in', () => {
  test('the seeded super admin can sign in', async ({ page }) => {
    await onAppSurface(page);

    const response = await browserFetch(page, '/api/auth/sign-in/email', {
      method: 'POST',
      json: { email: E2E.adminEmail, password: E2E.adminPassword },
    });

    expect(response.status, response.body).toBe(200);
    expect(response.body).toContain(E2E.adminEmail);

    // A session cookie actually landed in the browser, on the app surface and nowhere else.
    const cookies = await page.context().cookies();
    const session = cookies.find((c) => c.name.includes('session'));
    expect(session, JSON.stringify(cookies)).toBeTruthy();
    expect(session!.httpOnly).toBe(true);
    expect(session!.domain).toContain(`app.${E2E.domain}`);
  });

  test('a wrong password is refused', async ({ page }) => {
    await onAppSurface(page);

    const response = await browserFetch(page, '/api/auth/sign-in/email', {
      method: 'POST',
      json: { email: E2E.adminEmail, password: 'definitely-not-the-password' },
    });

    expect(response.status).toBeGreaterThanOrEqual(400);
  });

  test('an unknown email is refused, and says no more than a wrong password does', async ({
    page,
  }) => {
    await onAppSurface(page);

    const unknown = await browserFetch(page, '/api/auth/sign-in/email', {
      method: 'POST',
      json: { email: 'stranger@souqbartaa.test', password: 'whatever-123456' },
    });

    const wrongPassword = await browserFetch(page, '/api/auth/sign-in/email', {
      method: 'POST',
      json: { email: E2E.adminEmail, password: 'definitely-not-the-password' },
    });

    // Identical status codes: a difference here is an account-enumeration oracle that hands an
    // attacker the platform's customer list one guess at a time.
    expect(unknown.status).toBe(wrongPassword.status);
  });
});

test.describe('Q1 — no self-registration anywhere', () => {
  test('the sign-up endpoint refuses, even with a perfectly valid body', async ({ page }) => {
    await onAppSurface(page);

    // Not "there is no link to it" — the endpoint itself refuses. Accounts are created by the
    // super admin and by nobody else.
    const response = await browserFetch(page, '/api/auth/sign-up/email', {
      method: 'POST',
      json: {
        email: 'intruder@souqbartaa.test',
        password: 'AVeryStrongPassword!2026',
        name: 'محاولة تسجيل',
      },
    });

    expect(response.status).toBeGreaterThanOrEqual(400);

    // And no session was issued as a consolation prize.
    const cookies = await page.context().cookies();
    expect(cookies.find((c) => c.name.includes('session'))).toBeFalsy();
  });
});

test.describe('password reset', () => {
  test('a reset request sends a real Arabic RTL email carrying a working link', async ({ page }) => {
    await onAppSurface(page);

    const response = await browserFetch(page, '/api/auth/request-password-reset', {
      method: 'POST',
      json: { email: E2E.adminEmail, redirectTo: `${origin('app')}/reset-password` },
    });

    expect(response.status, response.body).toBe(200);

    const message = await waitForMail(
      (decoded) => decoded.includes(E2E.adminEmail) && decoded.includes('إعادة تعيين كلمة المرور'),
    );

    // Arabic, RTL, addressed to the right person — an email is a user-facing surface and the
    // language gate applies to it exactly as it does to a page.
    expect(message).toContain('dir="rtl"');
    expect(message).toContain('lang="ar"');

    // The link is a real, resolvable reset URL — not a placeholder. better-auth carries the
    // token in the PATH and the destination in callbackURL.
    const resetLink = linksIn(message).find((link) => link.includes('/reset-password/'));
    expect(resetLink, `no reset link in:\n${message.slice(0, 1500)}`).toBeTruthy();

    const token = new URL(resetLink!).pathname.split('/').pop() ?? '';
    expect(token.length).toBeGreaterThan(15);
    expect(resetLink).toContain('callbackURL=');
  });

  test('a reset request for an unknown address does not reveal whether it exists', async ({
    page,
  }) => {
    await onAppSurface(page);
    const before = capturedMail().length;

    const response = await browserFetch(page, '/api/auth/request-password-reset', {
      method: 'POST',
      json: {
        email: 'nobody-here@souqbartaa.test',
        redirectTo: `${origin('app')}/reset-password`,
      },
    });

    expect(response.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(capturedMail().length).toBe(before);
  });
});

test.describe('the export link is reachable without a session', () => {
  test('an invalid token gets the Arabic explanation, not a login wall', async ({ page }) => {
    // Q18: a suspended merchant opens this from a WhatsApp message. Requiring a session would
    // make the promise unkeepable for exactly the person it exists for.
    const response = await page.goto(`${origin('app')}/export/this-token-does-not-exist-at-all`);

    expect(response?.status()).toBe(404);
    await expect(page.getByText('الرابط غير صالح')).toBeVisible();
  });
});
