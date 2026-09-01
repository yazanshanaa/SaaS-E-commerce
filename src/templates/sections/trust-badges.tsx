import type { SVGProps } from 'react';
import type { SectionConfig } from '@/shared/site-contract';
import { translator } from '@/shared/i18n';
import {
  BoxIcon,
  CheckIcon,
  ClockIcon,
  PhoneIcon,
  ShieldIcon,
  StarIcon,
  TruckIcon,
  WalletIcon,
} from '../components/icons';
import { SECTION_ANCHORS } from '../section-anchors';
import type { StorefrontContext } from '../view-model';
import { SectionBlock } from './block';

const ct = translator('content');

/**
 * The trust row — «توصيل مجاني فوق ₪400» / «ادفعي لما توصلك» / «تغليف محتشم».
 *
 * Three short claims with a subtitle each, and a GLYPH per claim rather than an emoji. CLAUDE.md
 * forbids emoji as icons and `components/icons.tsx` gives the reason beyond taste: an emoji renders as
 * a different picture on every platform, is announced as a word by a screen reader, and has no
 * relationship to the template's colours.
 *
 * All eight glyphs now live in `components/icons.tsx`, which is where the platform's icon set lives.
 * Five of them were drawn here at first, against a duplicated copy of that file's `Svg` wrapper,
 * because Track B did not own it — and the consequence was that `TrustBadge.icon @default("check")`
 * named a picture the platform did not have. They were moved in at Phase 9 integration.
 */

type IconProps = SVGProps<SVGSVGElement>;

/**
 * Icon key -> glyph. The keys are `TRUST_ICON_KEYS` in `src/server/content/trust-badges.ts`, and
 * `tests/unit/phase9-content.test.ts` asserts every one of them lands here — so the dashboard can
 * never offer a merchant an option that renders as nothing.
 */
const TRUST_GLYPHS: Record<string, (props: IconProps) => React.ReactElement> = {
  check: CheckIcon,
  truck: TruckIcon,
  shield: ShieldIcon,
  box: BoxIcon,
  wallet: WalletIcon,
  clock: ClockIcon,
  phone: PhoneIcon,
  star: StarIcon,
};

export interface StorefrontTrustBadge {
  id: string;
  icon: string;
  title: string;
  subtitle: string | null;
}

export interface TrustBadgesSectionProps {
  context: StorefrontContext;
  config: SectionConfig<'trust_badges'>;
  anchor?: string;
  badges?: StorefrontTrustBadge[];
}

function badgesFrom(
  context: StorefrontContext,
  injected?: StorefrontTrustBadge[],
): StorefrontTrustBadge[] {
  if (injected) return injected;
  return (context as StorefrontContext & { trustBadges?: StorefrontTrustBadge[] }).trustBadges ?? [];
}

export function TrustBadgesSection({ context, config, anchor, badges }: TrustBadgesSectionProps) {
  const shown = badgesFrom(context, badges).slice(0, config.limit ?? 3);
  if (shown.length === 0) return null;

  const title = config.title?.trim() || null;

  return (
    <SectionBlock
      anchor={anchor ?? SECTION_ANCHORS.trust_badges}
      title={title}
      className="sf-block--trust"
    >
      {/*
        A LIST, because it is one. Three sibling `<div>`s would leave a screen-reader user with no
        idea how many claims there are or where the row ends — and "three things" is exactly the
        information a trust row exists to convey at a glance.
      */}
      {/*
        `sf-panel` is Phase 11's reassurance-block treatment, selected by the shell's `data-panel`
        attribute: a rounded colour block on دار, a ruled box on ديوان/رفّ, a torn tape strip on
        سوق نيون/مطبخ, and NOTHING on a `plain` template — the class is inert there, so the five
        launch templates that predate it render byte-identically until their own data attribute
        says otherwise. One panel containing three lines of shop policy, never three floating
        feature cards (the CLAUDE.md-forbidden pattern the phase plan calls out by name).
      */}
      <ul className="sf-trust sf-panel" aria-label={title ?? ct('sections.trustBadges')}>
        {shown.map((badge) => {
          // An unknown stored key falls back to `check` rather than rendering an empty box: the set
          // can shrink between deploys, and a merchant's live homepage is not where that shows up.
          const Icon = TRUST_GLYPHS[badge.icon] ?? CheckIcon;

          return (
            <li className="sf-trust__item" key={badge.id}>
              <Icon className="sf-trust__icon" width={24} height={24} />
              <span className="sf-trust__copy">
                <span className="sf-trust__title">{badge.title}</span>
                {badge.subtitle ? (
                  <span className="sf-trust__text">{badge.subtitle}</span>
                ) : null}
              </span>
            </li>
          );
        })}
      </ul>
    </SectionBlock>
  );
}

export { TRUST_GLYPHS };
