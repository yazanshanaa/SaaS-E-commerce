/**
 * The inline trend line — signature element #1 of «مرصد» (`DESIGN_BRIEF.md`).
 *
 * WHY IT EXISTS. Before this component the platform contained ZERO data visualisation: the
 * insights screen was three `<table>`s, the analytics screen one, and the only graphical
 * indicator anywhere was `.sbd-meter`, an 8px progress bar. A merchant could read that today's
 * sales were 1,240 ₪ and had no way at all to see whether that was a good day. A number without
 * its own recent history is a fact without a verdict.
 *
 * WHY IT IS NOT A CHART LIBRARY. `package.json` has no UI dependencies at all — no Recharts, no
 * D3, no Chart.js — and adding one for a 26px line would ship a client bundle to a server-
 * rendered page that currently needs none, on a platform held to LCP < 2.5s over Fast 3G. This
 * is one `<svg>` with two `<path>`s, rendered on the server, no JavaScript on the client.
 *
 * WHY IT IS SAFE WITH REAL DATA. Every input is normalised into the viewBox here, so a series of
 * identical values, a single point, an empty array, or values spanning six orders of magnitude
 * all produce a valid path rather than `NaN` in a `d` attribute (which renders as nothing and is
 * invisible in review — the same class of silent failure as a fallback font).
 *
 * ACCESSIBILITY. `aria-hidden`, always. The KPI value sits next to it as real text, and the
 * trend is redundant with the delta already stated in words. A screen reader announcing a
 * decorative polyline adds noise, not information. There is no interactivity, no tooltip and no
 * focus stop — this is a texture that tells you the shape of the week at a glance, not a
 * queryable chart.
 *
 * RTL. Time runs from the inline START, so the OLDEST point is on the right and the newest on
 * the left. Getting this backwards would draw growth as decline on an Arabic page, which is the
 * kind of error that looks fine to whoever ships it.
 */

const W = 100;
const H = 26;
/** Keeps the stroke's own width inside the box so the extremes are not clipped. */
const INSET = 2;

export interface SparklineProps {
  /** Oldest first. Rendered right-to-left so the newest point lands at the inline end. */
  values: readonly number[];
  /**
   * Fill the area under the line. On a dense grid of four KPI cards the fills start to read as
   * blocks of colour rather than as trends, so the caller decides.
   */
  filled?: boolean;
  /** Line colour. Defaults to `currentColor`, which inherits the card's accent. */
  stroke?: string;
}

export function Sparkline({ values, filled = true, stroke = 'currentColor' }: SparklineProps) {
  // Fewer than two points is not a trend. Render nothing rather than a dot pretending to be one.
  if (values.length < 2) return null;

  const finite = values.filter((value) => Number.isFinite(value));
  if (finite.length < 2) return null;

  const min = Math.min(...finite);
  const max = Math.max(...finite);
  const span = max - min;

  const stepX = (W - INSET * 2) / (finite.length - 1);

  const points = finite.map((value, index) => {
    // RTL: index 0 (oldest) sits at the RIGHT edge and time advances leftward.
    const x = W - INSET - index * stepX;
    /*
     * A flat series has `span === 0`. Dividing by it yields NaN and a path that silently renders
     * nothing, so a flat week is drawn as a line through the middle — which is what it is.
     */
    const ratio = span === 0 ? 0.5 : (value - min) / span;
    const y = H - INSET - ratio * (H - INSET * 2);
    return `${x.toFixed(2)} ${y.toFixed(2)}`;
  });

  const line = `M ${points.join(' L ')}`;
  const area = `${line} L ${INSET} ${H} L ${W - INSET} ${H} Z`;

  return (
    <svg
      className="sbk-spark"
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      aria-hidden="true"
      focusable="false"
    >
      {filled ? <path className="sbk-spark__area" d={area} fill={stroke} /> : null}
      <path
        className="sbk-spark__line"
        d={line}
        fill="none"
        stroke={stroke}
        strokeWidth={1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
        /*
         * `vector-effect` keeps the stroke 1.8px after `preserveAspectRatio="none"` stretches the
         * viewBox to the card's width. Without it a wide card draws a hairline and a narrow one
         * draws a slab, and the four cards in a row stop matching.
         */
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
