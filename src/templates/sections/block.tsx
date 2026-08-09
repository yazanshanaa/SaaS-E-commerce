import type { ReactNode } from 'react';

/**
 * The section wrapper every block shares: the anchor, the shell, and exactly one `h2`.
 *
 * Heading level is fixed at 2 on purpose. The page owns the single `h1` (the hero, or a
 * visually-hidden shop name when there is no hero), sections are `h2`, and cards inside them
 * are `h3`. A section that chose its own level would let a merchant reorder their page into a
 * heading outline that jumps from 1 to 4 — an axe finding produced by a drag-and-drop.
 */
export interface SectionBlockProps {
  anchor: string;
  title?: string | null;
  lead?: string | null;
  children: ReactNode;
  /** Extra class for the rare block that needs a full-bleed background. */
  className?: string;
}

export function SectionBlock({ anchor, title, lead, children, className }: SectionBlockProps) {
  return (
    <section id={anchor} className={className ? `sf-block ${className}` : 'sf-block'}>
      <div className="sf-shell">
        {title ? (
          <div className="sf-block__head">
            <h2 className="sf-block__title">{title}</h2>
            {lead ? <p className="sf-block__lead">{lead}</p> : null}
          </div>
        ) : null}
        {children}
      </div>
    </section>
  );
}
