import type { SectionConfig } from '@/shared/site-contract';
import { sanitizeHtml } from '../lib/sanitize-html';
import { SECTION_ANCHORS } from '../section-anchors';
import type { StorefrontContext } from '../view-model';
import { SectionBlock } from './block';

/**
 * `custom_html` — the only section that renders markup somebody typed.
 *
 * Three gates, and all three are enforced before a byte reaches the page:
 *   1. `context.flags.customHtml`, resolved server-side from the availability axis
 *      (see `lib/custom-html-gate.ts` — and the sync point recorded there about the missing
 *      feature key),
 *   2. never for a demo tenant, which the same gate enforces unconditionally,
 *   3. `sanitizeHtml`, an allow-list tokeniser that drops anything able to execute.
 *
 * Returning null when the flag is off is not merely hiding it: the markup is never fetched into
 * the response at all.
 */

export interface CustomHtmlSectionProps {
  context: StorefrontContext;
  config: SectionConfig<'custom_html'>;
}

export function CustomHtmlSection({ context, config }: CustomHtmlSectionProps) {
  if (!context.flags.customHtml) return null;

  const html = sanitizeHtml(config.html ?? '');
  if (!html.trim()) return null;

  return (
    <SectionBlock anchor={SECTION_ANCHORS.custom_html}>
      <div className="sf-prose" dangerouslySetInnerHTML={{ __html: html }} />
    </SectionBlock>
  );
}
