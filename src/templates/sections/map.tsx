import type { SectionConfig } from '@/shared/site-contract';
import { MapPinIcon, NavigationIcon } from '../components/icons';
import { st } from '../i18n';
import { resolveMapTarget } from '../lib/map-links';
import { SECTION_ANCHORS } from '../section-anchors';
import type { StorefrontContext } from '../view-model';
import { SectionBlock } from './block';

/**
 * "موقعنا" — two deep links and the address, and deliberately no embedded map.
 *
 * The fallback chain is the whole point of this section (see `lib/map-links.ts`): coordinates,
 * then the section's own free-text query, then `Site.mapQuery`, then `Site.address`. The demo
 * packs ship an address string and NO coordinates, so a section that required `mapLat`/`mapLng`
 * would render a dead map on every demo — on the one day it is put in front of a customer.
 *
 * With nothing at all to point at, the block still renders its heading and says so plainly,
 * because a merchant who has not set a location should see that fact on their own site.
 */

export interface MapSectionProps {
  context: StorefrontContext;
  config: SectionConfig<'map'>;
  /** Unique-per-page override from `SectionList`; falls back to the type's stable anchor. */
  anchor?: string;
}

export function MapSection({ context, config, anchor }: MapSectionProps) {
  const { site } = context;

  const target = resolveMapTarget({
    lat: site.mapLat,
    lng: site.mapLng,
    configQuery: config.query,
    siteQuery: site.mapQuery,
    address: site.address,
  });

  return (
    <SectionBlock
      anchor={anchor ?? SECTION_ANCHORS.map}
      title={config.title?.trim() || st('sections.map')}
    >
      {target ? (
        <div className="sf-contact">
          <dl className="sf-facts">
            <div>
              <dt>{st('map.address')}</dt>
              {/* The coordinates target still shows the human address when there is one. */}
              <dd>{site.address ?? target.value}</dd>
            </div>
          </dl>
          <div className="sf-actions">
            <a className="sf-btn" href={target.googleUrl} rel="noopener noreferrer" target="_blank">
              <MapPinIcon className="sf-btn__icon" />
              {st('map.google')}
            </a>
            <a
              className="sf-btn sf-btn--ghost"
              href={target.wazeUrl}
              rel="noopener noreferrer"
              target="_blank"
            >
              <NavigationIcon className="sf-btn__icon" />
              {st('map.waze')}
            </a>
          </div>
        </div>
      ) : (
        <p className="sf-note">{st('map.empty')}</p>
      )}
    </SectionBlock>
  );
}
