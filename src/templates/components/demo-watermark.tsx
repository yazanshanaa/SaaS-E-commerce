import { ct } from '../i18n';

/**
 * The demo watermark, driven by `Tenant.isDemo` — THE canonical predicate, resolved once in
 * proxy.ts and read from the request context (docs/PHASES.md rule 5).
 *
 * It is a real element with real text rather than a CSS `content` string, so a screen reader
 * and a search engine both learn what they are looking at. `pointer-events: none` keeps it from
 * eating a tap on whatever sits under it — a watermark that blocks the WhatsApp button during a
 * sales demo is worse than no watermark at all.
 */
export function DemoWatermark() {
  return <p className="sf-watermark">{ct('demoWatermark')}</p>;
}
