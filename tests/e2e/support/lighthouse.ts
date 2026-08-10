import { launch, type LaunchedChrome } from 'chrome-launcher';
import lighthouse from 'lighthouse';
import { chromium } from 'playwright';
import { E2E } from './env';

/**
 * Lighthouse against the running e2e stack.
 *
 * A2's acceptance criterion is a NUMBER — "Lighthouse mobile perf ≥ 90 on a template with 30
 * products" — and the mechanical proxies the suite already asserts (one preloaded subset font,
 * zero cross-origin requests, explicit width/height on every image, lazy below the fold) are
 * exactly the inputs to that number, never the number itself. A budget nothing measures is a
 * budget nobody keeps, so this closes the loop.
 *
 * Three things are deliberate:
 *
 *   1. IT DRIVES ITS OWN CHROME, not Playwright's page. Lighthouse needs sole ownership of the
 *      DevTools protocol session — it throttles the network, clears the cache and reloads — so
 *      sharing a Playwright context would measure a warm cache and report a fiction. The binary
 *      is Playwright's own Chromium (`chromium.executablePath()`), which is already installed
 *      and version-pinned by the lockfile; searching the machine for an installed Chrome makes
 *      the gate depend on what a developer happens to have.
 *
 *   2. IT KEEPS THE HOST-RESOLVER RULE. Every storefront resolves by hostname, so a run against
 *      127.0.0.1 would resolve no tenant and score a 404 — which Lighthouse is perfectly happy
 *      to give a 100 for.
 *
 *   3. IT RETURNS ALL FOUR CATEGORIES. Only performance is gated by docs/PHASES.md, but the
 *      other three are free once Chrome is up, and CLAUDE.md carries targets for them.
 */

export interface LighthouseScores {
  /** 0-100, rounded the way the Lighthouse report rounds them. */
  performance: number;
  accessibility: number;
  bestPractices: number;
  seo: number;
  /** The metrics behind the score, for a failure message worth reading. */
  metrics: {
    firstContentfulPaintMs: number;
    largestContentfulPaintMs: number;
    totalBlockingTimeMs: number;
    cumulativeLayoutShift: number;
    speedIndexMs: number;
  };
}

export async function runLighthouse(url: string): Promise<LighthouseScores> {
  const chrome: LaunchedChrome = await launch({
    chromePath: chromium.executablePath(),
    chromeFlags: [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      `--host-resolver-rules=MAP *${E2E.domain} 127.0.0.1, MAP ${E2E.domain} 127.0.0.1`,
    ],
  });

  try {
    // No `config` argument: the default preset IS mobile — a Moto G Power viewport, Slow 4G
    // throttling and a 4x CPU slowdown. That is the number docs/PHASES.md asks for, and
    // hand-rolling a config here would quietly grade on an easier curve.
    const result = await lighthouse(url, {
      port: chrome.port,
      output: 'json',
      logLevel: 'error',
      onlyCategories: ['performance', 'accessibility', 'best-practices', 'seo'],
    });

    if (!result) throw new Error(`Lighthouse produced no result for ${url}`);

    const { categories, audits } = result.lhr;

    return {
      performance: score(categories.performance?.score),
      accessibility: score(categories.accessibility?.score),
      bestPractices: score(categories['best-practices']?.score),
      seo: score(categories.seo?.score),
      metrics: {
        firstContentfulPaintMs: numeric(audits['first-contentful-paint']?.numericValue),
        largestContentfulPaintMs: numeric(audits['largest-contentful-paint']?.numericValue),
        totalBlockingTimeMs: numeric(audits['total-blocking-time']?.numericValue),
        cumulativeLayoutShift: numeric(audits['cumulative-layout-shift']?.numericValue),
        speedIndexMs: numeric(audits['speed-index']?.numericValue),
      },
    };
  } finally {
    await chrome.kill();
  }
}

/** A category with no score at all is a failed run, not a zero — say so rather than reporting 0. */
function score(value: number | null | undefined): number {
  if (typeof value !== 'number') {
    throw new Error('Lighthouse returned a category with no score — the run did not complete');
  }
  return Math.round(value * 100);
}

function numeric(value: number | undefined): number {
  return typeof value === 'number' ? Math.round(value * 1000) / 1000 : Number.NaN;
}

export function formatScores(url: string, scores: LighthouseScores): string {
  const m = scores.metrics;
  return [
    `Lighthouse (mobile) ${url}`,
    `  performance ${scores.performance} · a11y ${scores.accessibility} · best-practices ${scores.bestPractices} · seo ${scores.seo}`,
    `  FCP ${Math.round(m.firstContentfulPaintMs)}ms · LCP ${Math.round(m.largestContentfulPaintMs)}ms · TBT ${Math.round(m.totalBlockingTimeMs)}ms · CLS ${m.cumulativeLayoutShift} · SI ${Math.round(m.speedIndexMs)}ms`,
  ].join('\n');
}
