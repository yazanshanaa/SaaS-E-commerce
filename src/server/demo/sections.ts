import {
  SECTION_TYPES,
  parseSectionConfig,
  type SectionType,
} from '@/shared/site-contract';
import type { DemoPack } from './types';

/**
 * Turning a frozen pack's `sections` into rows A2 will actually render.
 *
 * `docs/PHASES.md` says "sections in sort order (config as-is)", and taken literally that loses
 * copy. `src/shared/site-contract/sections.ts` STRIPS unknown keys by design, and three pack keys
 * are not the contract's names for the same thing:
 *
 *   hero.cta              -> hero.ctaLabel        ("اطلب عبر واتساب")
 *   contact_whatsapp.note -> contact_whatsapp.body ("رد سريع خلال ساعات الدوام")
 *   products_grid.showBadges -> nothing           (the grid has no badge toggle)
 *
 * Stored verbatim, the first two would be dropped at parse time and the storefront would fall back
 * to `st('hero.cta')` and `st('contact.body')` — generic defaults in place of the pack's own
 * Arabic, on the two blocks a prospect is most likely to read out loud during a sales call. The
 * packs are frozen and must not be edited to fit (`src/server/demo/types.ts` is reserved), so the
 * adaptation belongs here, in the consumer, and it is recorded as a sync point in
 * `docs/decisions/b3.md`.
 *
 * `showBadges` has no counterpart at all: the grid renders `Product.badge` whenever it is set, so
 * the pack's intent is already satisfied and the key is simply dropped. That is stated rather than
 * silently ignored — the day the contract grows a toggle, this is the line to change.
 *
 * Everything then goes through `parseSectionConfig`, so what is stored is byte-identical to what
 * A1's `seedDefaultSections` writes and to what A2 re-parses at render.
 */

type Aliases = Readonly<Record<string, string>>;

const CONFIG_ALIASES: Partial<Record<SectionType, Aliases>> = {
  hero: { cta: 'ctaLabel' },
  contact_whatsapp: { note: 'body' },
};

/**
 * A THING THIS FILE DELIBERATELY DOES NOT TRY TO FIX, recorded so nobody re-attempts it.
 *
 * `products_grid.columns` has `.default(3)` in the site contract, and the renderer reads
 * `config.columns ?? template.layout.gridColumns` — so warsheh's four dense columns and
 * neon-souq's two large ones are unreachable for any STORED section, and the three packs (already
 * structurally identical) render an identical grid.
 *
 * Stripping the defaulted key back out before storing it looks like the fix and is not one:
 * `normaliseSectionConfig` in `src/templates/lib/section-config.ts` re-parses the stored config on
 * every read, so the schema default is re-applied at render time regardless of what is in the row.
 * The only real fix is in `src/shared/site-contract/sections.ts` — not defaulting a field whose
 * absence is meaningful — and that is a forbidden shared file. Raised in `docs/decisions/b3.md`.
 */

export function isSectionType(value: string): value is SectionType {
  return (SECTION_TYPES as readonly string[]).includes(value);
}

export class UnknownSectionTypeError extends Error {
  constructor(readonly type: string, readonly packKey: string) {
    super(
      `Pack ${packKey} declares section type "${type}", which is not in the site contract. ` +
        'The packs are frozen — raise this in the main session rather than editing either side.',
    );
    this.name = 'UnknownSectionTypeError';
  }
}

export interface DemoSectionRow {
  type: SectionType;
  sort: number;
  config: Record<string, unknown>;
}

export interface SectionBuildContext {
  /** The requester's address, when the demo came from the public form. */
  address?: string | undefined;
}

function applyAliases(type: SectionType, config: Record<string, unknown>): Record<string, unknown> {
  const aliases = CONFIG_ALIASES[type];
  if (!aliases) return { ...config };

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    out[aliases[key] ?? key] = value;
  }
  return out;
}

/**
 * Sections in the pack's own `sort` order, parsed and ready to insert.
 *
 * The map section is the one place the REQUESTER wins over the pack. `createDemo` already applied
 * their address to `Site.address` and `Site.mapQuery`; leaving the pack's "برطعة — شارع السوق
 * الرئيسي" inside the section config would drop a pin on a street that is not theirs, on a demo
 * built for their shop — and the section config is read before `Site.mapQuery` is consulted.
 */
export function buildSectionRows(
  pack: DemoPack,
  context: SectionBuildContext = {},
): DemoSectionRow[] {
  return [...pack.sections]
    .sort((a, b) => a.sort - b.sort)
    .map((section, index) => {
      if (!isSectionType(section.type)) {
        throw new UnknownSectionTypeError(section.type, pack.pack);
      }

      const aliased = applyAliases(section.type, section.config);

      if (section.type === 'map' && context.address) {
        aliased.query = context.address;
      }

      return {
        type: section.type,
        // The pack's `sort` values start at 1; the stored order is dense and zero-based, matching
        // what `moveSection` in A1 assumes when it swaps two neighbours.
        sort: index,
        config: parseSectionConfig(section.type, aliased) as Record<string, unknown>,
      };
    });
}
