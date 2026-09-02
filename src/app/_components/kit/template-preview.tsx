/*
 * IMPORTED FROM `@/templates/registry`, NOT FROM THE `@/templates` BARREL — deliberately, and
 * against that barrel's own stated convention. The convention exists so `src/app` does not couple
 * itself to a template's internal shape; `registry.ts` is a stable module of pure data objects, so
 * that concern does not apply, and the barrel carries a cost this component cannot pay.
 *
 * The barrel re-exports `StorefrontShell`, `CheckoutForm`, `CartView`, `useCart` and two dozen
 * other storefront components. This preview is rendered inside `appearance-studio.tsx`, which is
 * a `'use client'` component — so importing the barrel would pull the entire storefront render
 * tree, hooks and all, into the merchant dashboard's CLIENT bundle. Tree-shaking does not reliably
 * save a barrel that wide, and the failure is silent: the page still works, it is just megabytes
 * heavier, on a product held to LCP < 2.5s over Fast 3G.
 */
import { TEMPLATE_IMPLEMENTATIONS } from '@/templates/registry';
import type { TemplateDefinition } from '@/templates/types';
import type { TemplateKey } from '@/shared/site-contract';

/**
 * A template's thumbnail, DERIVED from the template rather than photographed.
 *
 * WHY THIS IS NOT A SCREENSHOT. The obvious fix for "the picker shows no previews" is a PNG per
 * template in `public/templates/`, which is what the abandoned `Template.preview_path` column was
 * for. Three reasons not to:
 *
 *   1. IT GOES STALE SILENTLY. A screenshot is a copy of the design at one moment. Change a
 *      template's palette or its grid and the picker keeps advertising the old one — with no test
 *      that can tell, because a stale PNG is still a valid PNG. This component reads
 *      `TEMPLATE_IMPLEMENTATIONS` at render time, so it is wrong only if the template is wrong.
 *   2. NINE TEMPLATES IS NOT THE CEILING. Every future template would need someone to remember to
 *      re-shoot it, plus a headless-browser step in a pipeline that currently has none.
 *   3. A THUMBNAIL IS NOT A PHOTOGRAPH. At 13rem wide, real Arabic copy is illegible noise. A
 *      wireframe of the actual STRUCTURE — where the picture sits, how many columns, whether the
 *      price is on the image or under it, what shape the images are cut to — is what a merchant
 *      is choosing between, and it reads at this size.
 *
 * WHAT IS ACTUALLY DRAWN. Every value below comes from the template's own definition: the five
 * ground colours, the radii, `layout.hero`, `layout.productCard`, `layout.gridColumns` and
 * `layout.imageMask`. Nothing is hand-tuned per template, so all nine are directly comparable —
 * which is the only way a picker helps anyone decide.
 *
 * RTL. The storefronts are `dir="rtl"`, so copy sits at the INLINE START (the right) and the
 * picture at the end (the left). Coordinates are written that way rather than mirrored with a
 * transform, which would flip the asymmetric masks the wrong way round.
 *
 * Server component: no state, no effects, no client JS. `aria-hidden` because the name and
 * description next to it in the card already carry the meaning — a screen reader announcing a
 * wireframe twice is worse than not announcing it.
 */

const W = 320;
const H = 208;

/** The preview is ~0.29× a real 1120px page, so template radii are scaled to match. */
const RADIUS_SCALE = 0.42;

function radius(value: string): number {
  const px = Number.parseFloat(value);
  if (!Number.isFinite(px)) return 0;
  // A `pill` of 999px must not become a 420px arc on a 320px canvas.
  return Math.min(px * RADIUS_SCALE, 12);
}

/**
 * The image mask, as a clip path over one rect. `arch` is a half-circle top, `notch` a ticket cut
 * at the corner nearest the reader; `square` returns undefined so no clip is applied at all.
 */
function maskPath(
  mask: TemplateDefinition['layout']['imageMask'],
  x: number,
  y: number,
  w: number,
  h: number,
): string | undefined {
  if (mask === 'square') return undefined;

  if (mask === 'arch') {
    const r = w / 2;
    const straight = Math.max(h - r, h * 0.35);
    return `M ${x} ${y + h} L ${x} ${y + h - straight} A ${r} ${r} 0 0 1 ${x + w} ${
      y + h - straight
    } L ${x + w} ${y + h} Z`;
  }

  // notch — the corner cut sits at the inline END (the left) so it reads as a torn stub in RTL.
  const cut = Math.min(w, h) * 0.28;
  return `M ${x + w} ${y} L ${x} ${y} L ${x} ${y + h - cut} L ${x + cut} ${y + h} L ${x + w} ${
    y + h
  } Z`;
}

/** A bar standing in for a line of text. Never real copy — see the header. */
function Bar({
  x,
  y,
  w,
  h = 4,
  fill,
  opacity = 1,
}: {
  x: number;
  y: number;
  w: number;
  h?: number;
  fill: string;
  opacity?: number;
}) {
  return <rect x={x} y={y} width={w} height={h} rx={h / 2} fill={fill} opacity={opacity} />;
}

export function TemplatePreview({ templateKey }: { templateKey: TemplateKey }) {
  const template = TEMPLATE_IMPLEMENTATIONS[templateKey];
  const { color } = template.tokens;
  const { hero, productCard, gridColumns, imageMask } = template.layout;

  const rMd = radius(template.tokens.radius.md);
  const rSm = radius(template.tokens.radius.sm);

  const pad = 14;
  const inner = W - pad * 2;

  // ---------------------------------------------------------------- header --
  const headerY = pad;
  const headerH = 18;

  // ------------------------------------------------------------------ hero --
  const heroY = headerY + headerH + 8;
  const heroH = 74;

  // ----------------------------------------------------------------- cards --
  const cardsY = heroY + heroH + 10;
  const cardsH = H - cardsY - pad;
  const gap = 7;
  const cardW = (inner - gap * (gridColumns - 1)) / gridColumns;

  // `spec` is a definition list, so its image is a strip; `overlay` fills the card with it.
  const artH = productCard === 'spec' ? cardsH * 0.34 : productCard === 'overlay' ? cardsH : 40;

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      width="100%"
      // No `role="img"`: a role names the element for assistive tech, which directly contradicts
      // `aria-hidden`. This is decorative — the name and description beside it carry the meaning.
      aria-hidden="true"
      focusable="false"
      style={{ display: 'block', borderRadius: 'inherit' }}
    >
      <rect width={W} height={H} fill={color.background} />

      {/* ---- header: mark + nav ticks, separated by the template's own rule ---- */}
      <rect x={pad} y={headerY} width={22} height={14} rx={rSm} fill={color.primary} />
      <Bar x={pad + 28} y={headerY + 5} w={40} h={5} fill={color.text} opacity={0.85} />
      <Bar x={W - pad - 24} y={headerY + 5} w={24} h={4} fill={color.textMuted} />
      <Bar x={W - pad - 56} y={headerY + 5} w={26} h={4} fill={color.textMuted} />
      <Bar x={W - pad - 90} y={headerY + 5} w={28} h={4} fill={color.textMuted} />
      <rect
        x={pad}
        y={headerY + headerH}
        width={inner}
        height={1}
        fill={color.border}
        opacity={0.7}
      />

      {/* ------------------------------- hero, one of three ------------------------------- */}
      {hero === 'split' && (
        <>
          {/* Copy at the inline start (right); portrait at the end (left). */}
          <Bar x={W - pad - 118} y={heroY + 14} w={118} h={9} fill={color.text} opacity={0.9} />
          <Bar x={W - pad - 92} y={heroY + 29} w={92} h={5} fill={color.textMuted} />
          <rect
            x={W - pad - 62}
            y={heroY + 44}
            width={62}
            height={16}
            rx={radius(template.tokens.radius.pill)}
            fill={color.primary}
          />
          {(() => {
            const x = pad;
            const w = 96;
            const path = maskPath(imageMask, x, heroY, w, heroH);
            return path ? (
              <path d={path} fill={color.primary} opacity={0.45} />
            ) : (
              <rect x={x} y={heroY} width={w} height={heroH} rx={rMd} fill={color.primary} opacity={0.45} />
            );
          })()}
        </>
      )}

      {hero === 'stage' && (
        <>
          <rect
            x={pad}
            y={heroY}
            width={inner}
            height={heroH}
            rx={rMd}
            fill={color.primary}
            opacity={0.9}
          />
          <Bar x={W - pad - 122} y={heroY + 22} w={110} h={9} fill={color.onPrimary} opacity={0.95} />
          <Bar x={W - pad - 122} y={heroY + 38} w={74} h={5} fill={color.onPrimary} opacity={0.7} />
          <rect
            x={W - pad - 122}
            y={heroY + 50}
            width={54}
            height={14}
            rx={radius(template.tokens.radius.pill)}
            fill={color.onPrimary}
            opacity={0.95}
          />
        </>
      )}

      {hero === 'ledger' && (
        <>
          {/* No decorative image: a banner strip over a facts list of hours, phone, address. */}
          <rect x={pad} y={heroY} width={inner} height={3} fill={color.primary} />
          <Bar x={W - pad - 130} y={heroY + 14} w={130} h={9} fill={color.text} opacity={0.9} />
          {[0, 1, 2].map((row) => (
            <g key={row}>
              <Bar
                x={W - pad - 46}
                y={heroY + 34 + row * 13}
                w={46}
                h={4}
                fill={color.textMuted}
              />
              <Bar
                x={W - pad - 118}
                y={heroY + 34 + row * 13}
                w={62}
                h={4}
                fill={color.text}
                opacity={0.55}
              />
            </g>
          ))}
          <rect
            x={pad}
            y={heroY + 30}
            width={58}
            height={30}
            rx={rSm}
            fill={color.secondary}
            opacity={0.35}
          />
        </>
      )}

      {/* --------------------- the products grid, one of three bodies --------------------- */}
      {Array.from({ length: gridColumns }, (_, i) => {
        // RTL: the first card sits at the inline start, i.e. the right edge.
        const x = W - pad - cardW - i * (cardW + gap);
        const artPath = maskPath(imageMask, x, cardsY, cardW, artH);

        return (
          <g key={i}>
            {productCard !== 'overlay' && (
              <rect
                x={x}
                y={cardsY}
                width={cardW}
                height={cardsH}
                rx={rMd}
                fill={color.surface}
                stroke={productCard === 'framed' ? color.secondary : color.border}
                strokeWidth={productCard === 'framed' ? 1.5 : 1}
                opacity={0.95}
              />
            )}

            {artPath ? (
              <path d={artPath} fill={color.primary} opacity={0.4} />
            ) : (
              <rect
                x={x}
                y={cardsY}
                width={cardW}
                height={artH}
                rx={productCard === 'overlay' ? rMd : 0}
                fill={color.primary}
                opacity={0.4}
              />
            )}

            {/* `overlay`: name and price sit ON the picture, over a scrim. No description. */}
            {productCard === 'overlay' && (
              <>
                <rect
                  x={x}
                  y={cardsY + cardsH - 24}
                  width={cardW}
                  height={24}
                  fill={color.background}
                  opacity={0.72}
                />
                <Bar
                  x={x + cardW - 6 - cardW * 0.55}
                  y={cardsY + cardsH - 18}
                  w={cardW * 0.55}
                  fill={color.text}
                  opacity={0.9}
                />
                <Bar
                  x={x + cardW - 6 - cardW * 0.3}
                  y={cardsY + cardsH - 10}
                  w={cardW * 0.3}
                  fill={color.primary}
                />
              </>
            )}

            {/* `framed`: the only body carrying a description sentence. */}
            {productCard === 'framed' && (
              <>
                <Bar
                  x={x + cardW - 8 - cardW * 0.6}
                  y={cardsY + artH + 7}
                  w={cardW * 0.6}
                  fill={color.text}
                  opacity={0.85}
                />
                <Bar
                  x={x + cardW - 8 - cardW * 0.75}
                  y={cardsY + artH + 16}
                  w={cardW * 0.75}
                  h={3}
                  fill={color.textMuted}
                />
                <Bar
                  x={x + cardW - 8 - cardW * 0.35}
                  y={cardsY + artH + 24}
                  w={cardW * 0.35}
                  fill={color.primary}
                />
              </>
            )}

            {/* `spec`: a definition list — price, availability, SKU. */}
            {productCard === 'spec' && (
              <>
                <Bar
                  x={x + cardW - 6 - cardW * 0.62}
                  y={cardsY + artH + 6}
                  w={cardW * 0.62}
                  fill={color.text}
                  opacity={0.85}
                />
                {[0, 1, 2].map((row) => (
                  <g key={row}>
                    <Bar
                      x={x + cardW - 6 - cardW * 0.34}
                      y={cardsY + artH + 16 + row * 8}
                      w={cardW * 0.34}
                      h={3}
                      fill={color.textMuted}
                    />
                    <Bar
                      x={x + 6}
                      y={cardsY + artH + 16 + row * 8}
                      w={cardW * 0.26}
                      h={3}
                      fill={row === 0 ? color.primary : color.text}
                      opacity={row === 0 ? 1 : 0.5}
                    />
                  </g>
                ))}
              </>
            )}
          </g>
        );
      })}
    </svg>
  );
}
