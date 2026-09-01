/**
 * The ornament layer's one piece of markup (Phase 11, Track 11.A).
 *
 * THE MARKUP IS IDENTICAL ON EVERY TEMPLATE — the same rule Phase 9 established for the `overlay`
 * card body, applied to ornaments: all three heading marks are always in the tree, and
 * `storefront.css` displays exactly the one the shell's `data-mark` attribute names. A template
 * swap is therefore a class swap, never a different render tree, and the preview iframe (11.D)
 * re-renders nothing to change ornaments.
 *
 * WHY THE OTHER TWO ORNAMENT FAMILIES HAVE NO COMPONENT. The phase plan sketched `<ArchFrame>` and
 * `<TicketNotch>` alongside this; both turned out to be pure CSS on boxes that already exist —
 * the arch is a corner radius and the notch a clip-path on `.sf-media`, selected by `data-mask`
 * and sized by the `--t-media-*` tokens — so a wrapper component would have added a render-tree
 * difference precisely where the design demands there be none. Recorded in docs/DECISIONS.md.
 *
 * Every ornament is `aria-hidden`: decoration must not reach a screen reader (invariant
 * extension 4), and the marks carry no information the heading itself does not.
 */
export function HeadingMark() {
  return (
    <span className="sf-mark" aria-hidden="true">
      {/* squiggle — drawn by a hand: three loose waves, round caps (ديوان، دار). */}
      <svg className="sf-mark__squiggle" viewBox="0 0 120 12" width="120" height="12" fill="none">
        <path
          d="M3 8 C 13 2, 23 2, 33 8 S 53 14, 63 8 S 83 2, 93 8 S 111 13, 117 7"
          stroke="currentColor"
          strokeLinecap="round"
        />
      </svg>
      {/* rule — a short confident line (سوق نيون، بيت، جهاز). */}
      <svg className="sf-mark__rule" viewBox="0 0 64 8" width="64" height="8" fill="none">
        <path d="M2 4 H 62" stroke="currentColor" strokeLinecap="round" />
      </svg>
      {/* ticket — a perforated stub edge, the shelf-talker's tear line (رفّ، مطبخ). */}
      <svg className="sf-mark__ticket" viewBox="0 0 96 8" width="96" height="8" fill="none">
        <path d="M2 4 H 94" stroke="currentColor" strokeLinecap="round" strokeDasharray="7 6" />
      </svg>
    </span>
  );
}
