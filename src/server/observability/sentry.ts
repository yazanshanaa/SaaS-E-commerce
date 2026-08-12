import * as Sentry from '@sentry/nextjs';
import { getEnv } from '@/env';
import { scrubSentryEvent } from '@/shared/sentry-scrub';

/**
 * Sentry on the server side (Q15) — the web server's node and edge runtimes, and the worker.
 *
 * This is the only `Sentry.init` in the repository. There is no browser half — see
 * `docs/DECISIONS.md` for why a storefront must not contact a third party on a visitor's behalf.
 *
 * The scrubber that decides what may leave lives in `src/shared/sentry-scrub.ts`, which is really
 * the implementation of two sentences of published Arabic privacy copy. Read that file's header
 * before changing anything about what is sent.
 *
 * DSN-GATED, DELIBERATELY. With no DSN the SDK is never initialised at all — as opposed to
 * initialised with `enabled: false`, which still installs instrumentation and still opens a
 * transport. That distinction is load-bearing: the e2e stack runs the real production build with
 * no DSN and asserts that a storefront logs nothing to the browser console, issues zero
 * cross-origin requests, and produces no failed request of any kind.
 */

export function sentryOptions(dsn: string, environment: string, tracesSampleRate: number) {
  return {
    dsn,
    environment,
    tracesSampleRate,
    /**
     * Session replay is off, and not because of cost. It records the session — every keystroke in
     * a product form, every price, the whole dashboard — and ships it to a third party, on a
     * platform whose privacy copy tells the reader Sentry receives the error and the path.
     */
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 0,
    /**
     * `sendDefaultPii: false` is the SDK's own switch for IP addresses, cookies and request
     * bodies. It is not sufficient on its own — hence the scrubber — but leaving it on while
     * scrubbing afterwards would mean the data was collected and then removed, and one missed
     * field is the difference.
     */
    sendDefaultPii: false,
    beforeSend: scrubSentryEvent,
    /**
     * `beforeSend` runs on ERROR events only. A performance transaction is a different envelope
     * type with its own hook, and it carries `request.url` just the same — so with tracing at the
     * default 0.1 a tenth of every request to `/export/{token}` would have carried the token past
     * the scrubber that exists to stop exactly that. Same function, because the policy is the
     * same policy.
     */
    beforeSendTransaction: scrubSentryEvent,
  } as const;
}

let started = false;

/**
 * Called from `register()` in `src/instrumentation.ts` and from `src/worker/index.ts`.
 *
 * The worker is the entrypoint that needs this most. A job that throws in a background container
 * produces no 500 that anybody sees; a suspension export that exhausts its retries is a merchant
 * who is never sent their data, and today its only trace is a log line on a box nobody is reading
 * at three in the morning.
 */
export function startSentry(): void {
  if (started) return;
  started = true;

  const env = getEnv();
  if (!env.SENTRY_DSN) return;

  Sentry.init(sentryOptions(env.SENTRY_DSN, env.SENTRY_ENVIRONMENT, env.SENTRY_TRACES_SAMPLE_RATE));
}
