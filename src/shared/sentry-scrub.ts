import type { init as sentryInit } from '@sentry/nextjs';

/**
 * What Sentry is allowed to carry off this platform.
 *
 * IT SITS APART FROM `src/server/observability/sentry.ts` ON PURPOSE, and the reason is a
 * precaution rather than an existing consumer. There is no browser SDK on this platform today
 * (`docs/DECISIONS.md` — it would make a visitor's browser contact a third party from a storefront
 * that promises zero cross-origin requests before consent). If one is ever added it will be
 * bundled into a public asset, and importing the server module would drag `src/env.ts` — the shape
 * of every secret this platform holds — along with it. Keeping the policy here, with no imports
 * but a type, means that day costs one import line rather than a second implementation of a rule
 * that has to stay in step with published Arabic copy.
 *
 * IT IS AN IMPLEMENTATION OF PUBLISHED TEXT, NOT A PREFERENCE. Once `SENTRY_DSN` is configured,
 * `src/server/legal/facts.ts` names Sentry in every tenant's generated privacy policy, and the
 * Arabic line it renders (messages/ar/legal.json, `processors.sentry`) makes two promises:
 *
 *   «يصلها وصف العطل ومسار الصفحة التي وقع فيها»    — the error, and the PATH of the page
 *   «مُهيّأة لاستبعاد محتوى النماذج ومفاتيح الوصول»  — form contents and access keys excluded
 *
 * Loosening anything below makes that a false statement on every storefront on the platform,
 * which is a different class of bug from a thin error report. `src/server/logger.ts`'s redaction
 * does not help here: Sentry has its own pipeline and reads its own sources, which is precisely
 * the risk Phase 6 recorded when it declined to name Sentry as a processor.
 */

type SentryOptions = NonNullable<Parameters<typeof sentryInit>[0]>;

/**
 * Errors AND transactions, because they are separate envelope types with separate hooks and the
 * same `request.url` on both. Typing the scrubber on the error event alone is what let
 * `beforeSendTransaction` go unwired in the first place — it simply would not have compiled, which
 * is the good version of this mistake.
 */
export type SentryEvent =
  | Parameters<NonNullable<SentryOptions['beforeSend']>>[0]
  | Parameters<NonNullable<SentryOptions['beforeSendTransaction']>>[0];

/**
 * Routes whose PATH carries a credential, not an identifier.
 *
 * Stripping the query string is the obvious half and it is not enough: Q18's export link is
 * `app.{DOMAIN}/export/{token}`, where the token IS the path segment — a live bearer credential
 * for a merchant's entire catalogue, valid for the whole retention window. An unhandled error
 * anywhere on that route (and the route exists to be opened by people who are confused and
 * clicking twice) would have shipped it to a third party in `request.url`, in plain text, where it
 * would then sit in an issue for ninety days.
 *
 * That is precisely the rule Phase 1 wrote down for event payloads and Phase 6 re-signed: no
 * payload, log line or Sentry event may carry a credential granting standing access to tenant
 * data. This is the list that keeps it true for URLs. Anything added later that puts a secret in a
 * path belongs here — `tests/unit/phase7-sentry-scrub.test.ts` is the reminder.
 */
const CREDENTIAL_PATHS: ReadonlyArray<{ pattern: RegExp; replacement: string }> = [
  // The Q18 suspension-export download link.
  { pattern: /(^|\/)export\/[^/?#]+/i, replacement: '$1export/[redacted]' },
];

/** The path, without the query string, and without any credential the path itself carries. */
export function pathOnly(url: string): string {
  const questionMark = url.indexOf('?');
  const path = questionMark === -1 ? url : url.slice(0, questionMark);

  return CREDENTIAL_PATHS.reduce(
    (redacted, { pattern, replacement }) => redacted.replace(pattern, replacement),
    path,
  );
}

export function scrubSentryEvent<T extends SentryEvent>(event: T): T {
  if (event.request) {
    /**
     * The request is REBUILT from the two fields the policy names rather than edited in place.
     * The difference matters over time: a deny-list stops covering a field the SDK starts
     * attaching in a future version, and nothing fails — it just quietly starts shipping. This
     * way a new field has to be added deliberately.
     *
     * The query string goes because on this platform it is routinely a credential: the export
     * download token, a signed-URL signature, a data-subject lookup.
     *
     * EVERY HEADER GOES, and not by filtering a list of bad ones. Two of them are outright
     * credentials, one is the internal shared secret, and three different ones carry the
     * visitor's IP address under a resolution policy that lives in exactly one file by invariant
     * 9 — a second place that decides what to do with those headers is the thing that invariant
     * exists to prevent. Weighed against that, a header buys nothing: an error is diagnosed from
     * the stack and the path, which is precisely what the published Arabic line says arrives.
     */
    const { url, method } = event.request;

    event.request = {
      url: typeof url === 'string' ? pathOnly(url) : url,
      method,
    };
  }

  // `extra` and `contexts.state` are where an integration parks whatever it happened to have:
  // component props, resolved loader data, a serialised store. On this platform any of those may
  // be a tenant's rows.
  delete event.extra;
  if (event.contexts) delete event.contexts.state;

  // Identity is not one of the two sentences. An error is fixable from the stack and the path;
  // attaching who hit it turns a crash log into an activity log of a merchant's working day.
  delete event.user;

  if (event.breadcrumbs) {
    event.breadcrumbs = event.breadcrumbs.map((crumb) => {
      const { data, ...rest } = crumb;
      // fetch/XHR breadcrumbs carry the full URL, query string included.
      if (data && typeof data.url === 'string') {
        return { ...rest, data: { url: pathOnly(data.url) } };
      }
      return rest;
    });
  }

  return event;
}
