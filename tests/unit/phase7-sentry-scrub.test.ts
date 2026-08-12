import { describe, expect, it } from 'vitest';
import { pathOnly, scrubSentryEvent, type SentryEvent } from '@/shared/sentry-scrub';
import { sentryOptions } from '@/server/observability/sentry';

/**
 * What Sentry is allowed to carry off this platform.
 *
 * This is not a test of a helper — it is the only mechanical check that a published Arabic
 * privacy disclosure is true. Once `SENTRY_DSN` is set, `src/server/legal/facts.ts` names Sentry
 * in every tenant's policy, and the line it renders promises the reader the error and the path of
 * the page, with form contents and access keys excluded. Everything below is one of those two
 * sentences.
 *
 * The case that matters most is the export token. Q18's link is
 * `app.{DOMAIN}/export/{token}` — the credential is the PATH, not the query string — so the
 * obvious implementation (strip the query, keep the path) ships a live bearer token for a
 * merchant's whole catalogue to a third party, from the one route most likely to be opened twice
 * by somebody confused.
 */

function event(request: Record<string, unknown>): SentryEvent {
  return { request } as unknown as SentryEvent;
}

describe('the Sentry scrubber', () => {
  it('redacts the export token, which lives in the path rather than the query', () => {
    expect(pathOnly('/export/Hdr0ib4kZuC93z93NlIaONRN0lPdjIqPSmIZjA9nd68')).toBe(
      '/export/[redacted]',
    );
    expect(pathOnly('https://app.example.test/export/abc123?x=1')).toBe(
      'https://app.example.test/export/[redacted]',
    );
  });

  it('keeps ordinary paths intact, so an error is still diagnosable', () => {
    expect(pathOnly('/products/zaytoun-olive-oil')).toBe('/products/zaytoun-olive-oil');
    expect(pathOnly('/dashboard/settings')).toBe('/dashboard/settings');
  });

  it('drops the query string, where every other credential on this platform lives', () => {
    // A demo link's token, a signed storage URL's signature, a data-subject lookup.
    expect(pathOnly('/?token=secret-demo-token')).toBe('/');
    expect(pathOnly('/media/x.webp?X-Amz-Signature=deadbeef&X-Amz-Expires=3600')).toBe(
      '/media/x.webp',
    );
  });

  it('sends no headers at all', () => {
    const scrubbed = scrubSentryEvent(
      event({
        url: '/dashboard',
        method: 'POST',
        headers: {
          cookie: 'souq_session=abcd',
          authorization: 'Bearer xyz',
          'cf-connecting-ip': '203.0.113.7',
          'user-agent': 'Mozilla/5.0',
        },
      }),
    );

    expect(scrubbed.request).toEqual({ url: '/dashboard', method: 'POST' });
  });

  it('drops the request body, the user, extra and framework state', () => {
    const scrubbed = scrubSentryEvent({
      request: { url: '/checkout', method: 'POST', data: { name: 'سامي', phone: '+970599123456' } },
      user: { id: 'user_1', email: 'merchant@example.test' },
      extra: { product: { priceAgorot: 4500 } },
      contexts: { state: { store: { orders: [1, 2, 3] } }, runtime: { name: 'node' } },
    } as unknown as SentryEvent);

    expect(scrubbed.request).toEqual({ url: '/checkout', method: 'POST' });
    expect(scrubbed.user).toBeUndefined();
    expect(scrubbed.extra).toBeUndefined();
    expect(scrubbed.contexts?.state).toBeUndefined();
    // Not everything goes: the runtime is what makes a stack trace readable.
    expect(scrubbed.contexts?.runtime).toEqual({ name: 'node' });
  });

  it('strips query strings and export tokens out of breadcrumbs too', () => {
    const scrubbed = scrubSentryEvent({
      breadcrumbs: [
        { category: 'fetch', data: { url: '/export/abc123?x=1', status_code: 500 } },
        { category: 'navigation', message: 'went somewhere' },
      ],
    } as unknown as SentryEvent);

    expect(scrubbed.breadcrumbs?.[0]?.data).toEqual({ url: '/export/[redacted]' });
    expect(scrubbed.breadcrumbs?.[1]).toEqual({ category: 'navigation', message: 'went somewhere' });
  });

  it('runs on transactions as well as errors, because both carry request.url', () => {
    // `beforeSend` fires for error events only. A performance transaction is a different envelope
    // with its own hook and the same URL on it, so a missing `beforeSendTransaction` would leak
    // the export token on a sampled request while every error was scrubbed perfectly.
    const options = sentryOptions('https://public@o0.ingest.sentry.io/1', 'test', 0.1);
    expect(options.beforeSend).toBe(scrubSentryEvent);
    expect(options.beforeSendTransaction).toBe(scrubSentryEvent);
  });

  it('never turns on session replay', () => {
    // It records the whole dashboard — every keystroke, every price — for a platform whose copy
    // says Sentry receives the error and the path.
    const options = sentryOptions('https://public@o0.ingest.sentry.io/1', 'production', 1);
    expect(options.replaysSessionSampleRate).toBe(0);
    expect(options.replaysOnErrorSampleRate).toBe(0);
    expect(options.sendDefaultPii).toBe(false);
  });
});
