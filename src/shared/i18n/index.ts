import common from '../../../messages/ar/common.json';
import admin from '../../../messages/ar/admin.json';
import dashboard from '../../../messages/ar/dashboard.json';
import storefront from '../../../messages/ar/storefront.json';
import media from '../../../messages/ar/media.json';
import billing from '../../../messages/ar/billing.json';
import demo from '../../../messages/ar/demo.json';

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

const NAMESPACES = {
  common,
  admin,
  dashboard,
  storefront,
  media,
  billing,
  demo,
} as const;

export type Namespace = keyof typeof NAMESPACES;

export type MessageParams = Record<string, string | number>;

function resolve(namespace: Namespace, key: string): unknown {
  let node: unknown = NAMESPACES[namespace];
  for (const segment of key.split('.')) {
    if (node === null || typeof node !== 'object') return undefined;
    node = (node as Record<string, unknown>)[segment];
  }
  return node;
}

/** `{name}` interpolation. Deliberately not full ICU — plurals in Arabic get their own helper. */
function interpolate(template: string, params?: MessageParams): string {
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
