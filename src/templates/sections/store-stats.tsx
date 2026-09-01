import type { SectionConfig } from '@/shared/site-contract';
import { translator } from '@/shared/i18n';
import { SECTION_ANCHORS } from '../section-anchors';
import type { StorefrontContext } from '../view-model';
import { SectionBlock } from './block';

const ct = translator('content');

/**
 * «7+ سنوات في السوق · 4000+ زبونة · 100% رضا».
 *
 * `value` IS RENDERED AS THE STRING IT IS STORED AS. No `formatNumber()`, no `Number()`, no
 * `Intl.NumberFormat` — and that is the one thing worth checking in review, because the platform rule
 * is "Western digits everywhere" and the reflex is to reach for the formatter. It cannot help here: the
 * figures are "7+", "4000+" and "100%", the merchant typed Western digits already, and parsing "7+" to
 * pass it through a formatter would print «7» and lose the plus — which is the model docblock's own
 * reason for the column being a `String`.
 *
 * `<dl>`, with the FIGURE as the description and the LABEL as the term. That ordering is deliberate:
 * «7+ / سنوات في السوق» reads as a definition, and a screen reader announcing the label before the
 * number is the sequence a human reads it in even though the figure is the larger type.
 */

export interface StorefrontStoreStat {
  id: string;
  /** A string, always. See above. */
  value: string;
  label: string;
}

export interface StoreStatsSectionProps {
  context: StorefrontContext;
  config: SectionConfig<'store_stats'>;
  anchor?: string;
  stats?: StorefrontStoreStat[];
}

function statsFrom(
  context: StorefrontContext,
  injected?: StorefrontStoreStat[],
): StorefrontStoreStat[] {
  if (injected) return injected;
  return (context as StorefrontContext & { storeStats?: StorefrontStoreStat[] }).storeStats ?? [];
}

export function StoreStatsSection({ context, config, anchor, stats }: StoreStatsSectionProps) {
  const shown = statsFrom(context, stats).slice(0, config.limit ?? 3);

  // Nothing to boast about yet is a section that should not be on the page, not an empty state — the
  // same call every Phase 9 section makes. A heading over three blanks reads as a broken template.
  if (shown.length === 0) return null;

  const title = config.title?.trim() || null;

  return (
    <SectionBlock
      anchor={anchor ?? SECTION_ANCHORS.store_stats}
      title={title}
      className="sf-block--stats"
    >
      <dl className="sf-stats" aria-label={title ?? ct('sections.storeStats')}>
        {shown.map((stat) => (
          <div className="sf-stat" key={stat.id}>
            <dt className="sf-stat__label">{stat.label}</dt>
            <dd className="sf-stat__value">{stat.value}</dd>
          </div>
        ))}
      </dl>
    </SectionBlock>
  );
}
