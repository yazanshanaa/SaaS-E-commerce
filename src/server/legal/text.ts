import catalog from '../../../messages/ar/legal.json';
import { interpolate, resolveIn, type MessageParams } from '@/shared/i18n';

/**
 * The legal catalogue's lookup — same semantics as `t()`, deliberately outside `NAMESPACES`.
 *
 * `t()` is imported by client components (the admin rail, the dashboard's forms), so every
 * namespace registered with it is bundled for the browser. This catalogue is thirty kilobytes of
 * policy prose that only `src/server/legal` ever reads, and shipping five privacy policies into
 * the JavaScript of a merchant editing a product is a cost with no return at all.
 *
 * Everything else about it is ordinary: it lives under `messages/ar/`, the language gate walks it
 * with the other seven, and no sentence is written into a component. The walk and the `{param}`
 * interpolation are imported rather than reimplemented — the flat-dotted-key fallback in `resolveIn`
 * is exactly the sort of behaviour that drifts when it exists twice.
 */

export function legalText(key: string, params?: MessageParams): string {
  const value = resolveIn(catalog, key);

  if (typeof value !== 'string') {
    /**
     * Throws outside production, exactly like `t()`. A missing key here would otherwise render as
     * a raw English identifier in the middle of an Arabic privacy policy — and unlike a mislabelled
     * button, nobody would notice until someone read the page carefully, which on a legal page is
     * usually a complaint.
     */
    if (process.env.NODE_ENV === 'production') return key;
    throw new Error(`Missing legal message: ${key}`);
  }

  return interpolate(value, params);
}

/** Used by the tests to prove every key the generator asks for exists. */
export const LEGAL_CATALOG: unknown = catalog;
