import type { ReactNode } from 'react';
import { HeadingMark } from '../components/ornaments';

/**
 * The section wrapper every block shares: the anchor, the shell, and exactly one `h2`.
 *
 * Heading level is fixed at 2 on purpose. The page owns the single `h1` (the hero, or a
 * visually-hidden shop name when there is no hero), sections are `h2`, and cards inside them
 * are `h3`. A section that chose its own level would let a merchant reorder their page into a
 * heading outline that jumps from 1 to 4 — an axe finding produced by a drag-and-drop.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * PHASE 12.E — THE HEAD HAS AN ANATOMY NOW, and the two slots below are why.
 *
 * The head was an `h2` and a margin. Every template sheet then drew a full-width hairline under it,
 * which is what made a homepage read as a DOCUMENT: a rule spanning the whole column says "a new
 * part of this article begins", and eight of them down a page is a table of contents, not a shop.
 *
 *   `eyebrow`  a short factual kicker above the title. Callers pass a COUNT they can prove —
 *              «15 منتج», «5 أقسام» — never a marketing line. It gives the head two tiers of
 *              hierarchy, which is what a single `h2` on an empty row could never have.
 *   `action`   the section's own link, on the title's baseline at the far end. Sections used to
 *              drop these UNDER their grid, where a visitor who has just scrolled past twelve
 *              products has already decided to leave.
 *
 * Both are optional and both default to absent, so every existing caller renders exactly what it
 * rendered before.
 */
export interface SectionBlockProps {
  anchor: string;
  title?: string | null;
  lead?: string | null;
  /**
   * A short, PROVABLE kicker above the title — a count, never a claim. See the note above: this
   * platform prints facts a merchant can stand behind, and an invented «الأفضل في المنطقة» is a
   * small lie in the shop's own voice.
   */
  eyebrow?: string | null;
  /** The section's own link, placed on the title's baseline at the far end of the head. */
  action?: ReactNode;
  children: ReactNode;
  /** Extra class for the rare block that needs a full-bleed background. */
  className?: string;
}

export function SectionBlock({
  anchor,
  title,
  lead,
  eyebrow,
  action,
  children,
  className,
}: SectionBlockProps) {
  return (
    <section id={anchor} className={className ? `sf-block ${className}` : 'sf-block'}>
      <div className="sf-shell">
        {title ? (
          <div className="sf-block__head">
            {/*
              THE TITLE STACK IS ITS OWN ELEMENT, and it has to be.

              The head is a two-part row — everything that names the section, and the section's one
              action pushed to the far end — and those two parts must bottom-align to each other
              regardless of how many lines the first one has. Without this wrapper the eyebrow, the
              title, the ornament and the lead are four independent children, so a flex row spreads
              them across the head and a grid auto-places the ornament into the action's cell. Both
              were tried; both put ديوان's squiggle where «شوف كل المنتجات» belongs.
            */}
            <div className="sf-block__titles">
              {eyebrow ? <p className="sf-block__eyebrow">{eyebrow}</p> : null}
              <h2 className="sf-block__title">{title}</h2>
              {/*
                Phase 11's heading mark — rendered for every template, DISPLAYED by the one whose
                `data-mark` names a variant (storefront.css). Identical markup everywhere is what
                keeps a template swap a class swap; `aria-hidden` inside the component is what keeps
                the ornament out of the accessibility tree.
              */}
              <HeadingMark />
              {lead ? <p className="sf-block__lead">{lead}</p> : null}
            </div>
            {action ? <div className="sf-block__action">{action}</div> : null}
          </div>
        ) : null}
        {children}
      </div>
    </section>
  );
}
