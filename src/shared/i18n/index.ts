import common from '../../../messages/ar/common.json';
import admin from '../../../messages/ar/admin.json';
import dashboard from '../../../messages/ar/dashboard.json';
import storefront from '../../../messages/ar/storefront.json';
import media from '../../../messages/ar/media.json';
import billing from '../../../messages/ar/billing.json';
import demo from '../../../messages/ar/demo.json';
// Phase 9. Five new namespaces rather than five new blocks inside `dashboard.json`, and the reason
// is not aesthetic: `dashboard.json` was already forty kilobytes, and Phase 9 builds its five
// surfaces in parallel tracks. One file that five tracks all append to is one file that produces
// five merge conflicts and, worse, silently loses a block when two of them resolve badly. Per-domain
// namespaces are also what `media`, `billing` and `demo` already are, so this follows the layout
// rather than inventing one.
import catalogue from '../../../messages/ar/catalogue.json';
import content from '../../../messages/ar/content.json';
import insights from '../../../messages/ar/insights.json';
import delivery from '../../../messages/ar/delivery.json';
import customers from '../../../messages/ar/customers.json';
// Phase 11 (Track 11.D): the appearance studio's copy — preview, picker, live contrast verdicts.
import appearance from '../../../messages/ar/appearance.json';

/**
 * Single locale, `ar`, dir="rtl".
 *
 * The product ships Arabic ONLY (CLAUDE.md language policy) — but every string still goes
 * through this layer rather than being written into a component. That is not ceremony: it is
 * what keeps a second locale cheap, and it is what makes the language gate mechanical (a
 * hardcoded Arabic literal in a component is as much a review failure as an English one,
 * because the next locale cannot reach it).
 *
 * Deliberately not next-intl: with one locale there is no routing, no negotiation and no
 * dynamic loading to do, and a dependency that does all three would be three more things to
 * hold still across seven phases.
 */

export const LOCALE = 'ar' as const;
export const DIRECTION = 'rtl' as const;
export type Locale = typeof LOCALE;

/**
 * `messages/ar/legal.json` is DELIBERATELY NOT HERE — see `src/server/legal/text.ts`.
 *
 * It is a real catalogue under `messages/ar/`, the language gate walks it like every other file,
 * and its copy is no more hardcoded than any other string. What it is not is client-reachable:
 * `t()` is imported by client components (the admin rail, the dashboard forms), so every namespace
 * in this map is bundled for the browser — and the legal catalogue is thirty kilobytes of policy
 * prose that only the server-side generator ever reads. Adding it here would have shipped five
 * privacy policies into the JavaScript of a merchant editing a product.
 */
const NAMESPACES = {
  common,
  admin,
  dashboard,
  storefront,
  media,
  billing,
  demo,
  // Phase 9
  catalogue,
  content,
  insights,
  delivery,
  customers,
  // Phase 11
  appearance,
} as const;

export type Namespace = keyof typeof NAMESPACES;

export type MessageParams = Record<string, string | number>;

/**
 * Walk a dotted key, and accept a group that stores its own keys FLAT with dots inside them.
 *
 * The walk alone was not enough, and the way it failed was invisible. `messages/ar/admin.json`
 * writes the audit vocabulary as `"events": { "subscription.suspended": "…" }` — one object whose
 * KEYS contain dots, because those keys are event type identifiers. Splitting on `.` looks for
 * `events → subscription → suspended`, finds nothing at the second step, and returns undefined.
 *
 * Both call sites guard with `messageExists()` and fall back to the raw identifier, so nothing
 * threw and nothing looked broken: the overview and the audit log simply rendered
 * `subscription.suspended` and `plan.created` — English identifiers, on the one screen whose whole
 * job is telling an Arabic-speaking operator what happened. Found by B3 (docs/decisions/b3.md §12)
 * while wondering why its own `demo.created` rows read that way.
 *
 * Fixed HERE rather than by nesting the JSON, because the identifiers are genuinely flat strings —
 * `events[type]` is how a caller thinks about them — and because this repairs A1's `actions.*`,
 * B3's `events.demo.*` and anything a later phase declares the same way, all at once. Only reached
 * when the ordinary walk has already failed, so it can turn no existing lookup into a different
 * answer; it can only turn `undefined` into the message that was there all along.
 */
function resolve(namespace: Namespace, key: string): unknown {
  return resolveIn(NAMESPACES[namespace], key);
}

/**
 * The same walk, over any catalogue object.
 *
 * Exported so a catalogue that is deliberately outside `NAMESPACES` — `messages/ar/legal.json`,
 * which is server-only — gets identical lookup semantics instead of a second, subtly different
 * implementation. The flat-dotted-key fallback below is exactly the kind of behaviour that would
 * drift if it were written twice.
 */
export function resolveIn(catalog: unknown, key: string): unknown {
  let node: unknown = catalog;
  const segments = key.split('.');

  for (let index = 0; index < segments.length; index += 1) {
    if (node === null || typeof node !== 'object') return undefined;
    const record = node as Record<string, unknown>;
    const segment = segments[index]!;

    if (segment in record) {
      node = record[segment];
      continue;
    }

    const literal = segments.slice(index).join('.');
    return literal in record ? record[literal] : undefined;
  }

  return node;
}

/** `{name}` interpolation. Deliberately not full ICU — plurals in Arabic get their own helper. */
export function interpolate(template: string, params?: MessageParams): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match,
  );
}

/**
 * Look up a message. A missing key throws in development and test so it surfaces at the first
 * render rather than shipping a raw key to a merchant; in production it degrades to the key,
 * because a half-broken page beats a blank one.
 */
export function t(namespace: Namespace, key: string, params?: MessageParams): string {
  const value = resolve(namespace, key);

  if (typeof value !== 'string') {
    if (process.env.NODE_ENV === 'production') return key;
    throw new Error(`Missing message: ${namespace}.${key}`);
  }

  return interpolate(value, params);
}

/** A bound `t` for one namespace — what components use. */
export function translator(namespace: Namespace) {
  return (key: string, params?: MessageParams): string => t(namespace, key, params);
}

export function messageExists(namespace: Namespace, key: string): boolean {
  return typeof resolve(namespace, key) === 'string';
}

// --- Formatting ---------------------------------------------------------------
// Western Arabic digits (0-9), ₪ for currency, Gregorian dates with Arabic month names.
// `ar` alone would give Eastern Arabic-Indic digits on some platforms, which is not what a
// shop owner in Bartaa reads on a price tag — hence the explicit -u-nu-latn extension.

const NUMERIC_LOCALE = 'ar-u-nu-latn';

export function formatNumber(value: number): string {
  return new Intl.NumberFormat(NUMERIC_LOCALE).format(value);
}

/** Agorot in, shekels out. Money is never a float until the moment it is displayed. */
export function formatAgorot(agorot: number): string {
  const shekels = agorot / 100;
  const body = new Intl.NumberFormat(NUMERIC_LOCALE, {
    minimumFractionDigits: agorot % 100 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(shekels);
  return `${body} ₪`;
}

export function formatDate(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  const months = common.months;
  const day = new Intl.NumberFormat(NUMERIC_LOCALE).format(d.getDate());
  const year = new Intl.NumberFormat(NUMERIC_LOCALE, { useGrouping: false }).format(d.getFullYear());
  return `${day} ${months[d.getMonth()]} ${year}`;
}

export function formatDateTime(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  const time = new Intl.DateTimeFormat(NUMERIC_LOCALE, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'Asia/Jerusalem',
  }).format(d);
  return `${formatDate(d)} · ${time}`;
}

export function formatBytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) {
    return `${formatNumber(Math.round((mb / 1024) * 10) / 10)} ${common.units.gigabyte}`;
  }
  return `${formatNumber(Math.round(mb * 10) / 10)} ${common.units.megabyte}`;
}
