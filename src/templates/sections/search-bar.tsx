import { t } from '@/shared/i18n';
import type { SectionConfig } from '@/shared/site-contract';
import { SearchBox } from '../components/search-box';
import { SECTION_ANCHORS } from '../section-anchors';
import type { StorefrontContext } from '../view-model';
import { SectionBlock } from './block';

/**
 * The `search_bar` section — a search box the merchant can place anywhere in their arrangement.
 *
 * WHY IT IS A SECTION RATHER THAN A FIXTURE IN THE HEADER. A shop with eight products does not want
 * one, and a search box that returns the whole catalogue is worse than no search box at all (the
 * reasoning already written on `Site.searchEnabled` in schema.prisma). Making it a section means the
 * merchant decides both WHETHER and WHERE, through the machinery that already exists for every other
 * block, and a grocer with 400 SKUs can put it above the fold while a boutique with twelve dresses
 * never adds it.
 *
 * IT DRAWS NOTHING WHEN SEARCH IS OFF. Two conditions have to hold — `can('search_insights')` and
 * the merchant's own `Site.searchEnabled` — and both are resolved on the SERVER, in the storefront
 * loader, and arrive here as one flag. The `/search` route re-asks both for itself, because this
 * decides what is DRAWN and a form left open across a toggle must not be able to reach a live route.
 *
 * THE COPY COMES FROM `messages/ar/insights.json`, not from `storefront.json`, and the reason is
 * organisational rather than architectural: Phase 9 builds its surfaces in parallel tracks and
 * `storefront.json` belongs to the main session. `insights` is this track's namespace and it holds
 * both halves of the same feature — the box a customer types into and the report the merchant reads.
 * The handoff doc notes the move for whoever consolidates later.
 */

export interface SearchBarSectionProps {
  context: StorefrontContext;
  config: SectionConfig<'search_bar'>;
  /** Unique-per-page override from `SectionList`; falls back to the type's stable anchor. */
  anchor?: string;
}

/**
 * `flags.search` read defensively.
 *
 * The flag is added to `StorefrontFlags` and resolved in `src/app/site/_data/context.ts` by the
 * handoff diff — both files belong to the main session. Until that lands, ABSENCE READS AS OFF, so
 * this track ships a section that is dark rather than one that renders a form pointing at a route
 * that will 404. Delete this helper and read `context.flags.search` directly once the field exists.
 */
function searchEnabled(flags: StorefrontContext['flags']): boolean {
  return (flags as { search?: boolean }).search === true;
}

export function SearchBarSection({ context, config, anchor }: SearchBarSectionProps) {
  if (!searchEnabled(context.flags)) return null;

  return (
    <SectionBlock
      anchor={anchor ?? SECTION_ANCHORS.search_bar}
      title={config.title?.trim() || t('insights', 'search.sectionTitle')}
    >
      <SearchBox
        labels={{
          field: t('insights', 'search.field'),
          placeholder: config.placeholder?.trim() || t('insights', 'search.placeholder'),
          submit: t('insights', 'search.submit'),
          region: t('insights', 'search.region'),
        }}
      />
    </SectionBlock>
  );
}
