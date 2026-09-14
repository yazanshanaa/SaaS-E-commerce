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
 * WHAT IS DRAWN (2026-09-14, the commerce anatomy). The redesign gave every template the same
 * storefront skeleton — sticky header with brand · search · cart/WhatsApp buttons, a department
 * bar, a compact hero, a row of category circles, then a product grid whose cards carry a square
 * picture, a price bubble and a full-width "add to cart" button. The previews had kept drawing
 * the pre-redesign blog-like page (tall hero, three loose cards), which is exactly the look the
 * owner asked to be rid of; the picker was advertising a layout no storefront renders any more.
 *
 * Everything below still comes from the template's own definition: the ground colours, the
 * radii, `layout.hero`, `layout.productCard` and `layout.imageMask`. What differs between the
 * nine is palette, corner radius, image mask, hero posture and the card body — which is what a
 * merchant is actually choosing between now that the skeleton is shared.
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
const H = 216;

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

/** The commerce grid is four-up on desktop for every template (storefront-commerce.css). */
const GRID_COLUMNS = 4;
const CIRCLES = 5;

export function TemplatePreview({ templateKey }: { templateKey: TemplateKey }) {
  const template = TEMPLATE_IMPLEMENTATIONS[templateKey];
  const { color } = template.tokens;
  const { hero, productCard, imageMask } = template.layout;

  const rMd = radius(template.tokens.radius.md);
  const rSm = radius(template.tokens.radius.sm);
  const rPill = radius(template.tokens.radius.pill);

  const pad = 12;
  const inner = W - pad * 2;

  // ------------------------------------------------ header: brand · search · actions --
  const headerY = 0;
  const headerH = 26;
  const searchW = 108;
  const searchH = 12;
  const searchX = W - pad - 60 - 6 - searchW;
  const btnW = 22;
  const btnH = 12;

  // ------------------------------------------------------------- department bar --
  const catbarY = headerH;
  const catbarH = 12;

  // ------------------------------------------------------------------ hero --
  const heroY = catbarY + catbarH + 7;
  const heroH = 44;

  // ------------------------------------------------------- category circles --
  const circlesY = heroY + heroH + 8;
  const circleD = 16;
  const circlesH = circleD + 6;

  // ----------------------------------------------------------------- cards --
  const cardsY = circlesY + circlesH + 7;
  const cardsH = H - cardsY - pad;
  const gap = 6;
  const cardW = (inner - gap * (GRID_COLUMNS - 1)) / GRID_COLUMNS;
  // Square media on every commerce card; `overlay` keeps its name-on-picture body.
  const artH = productCard === 'overlay' ? cardsH : Math.min(cardW, cardsH - 36);
  const btnY = cardsY + cardsH - 11;

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

      {/* ---- sticky header on the surface colour: brand (right) · search · cart/WhatsApp (left) ---- */}
      <rect x={0} y={headerY} width={W} height={headerH} fill={color.surface} />
      <rect x={0} y={headerY + headerH - 1} width={W} height={1} fill={color.border} opacity={0.8} />
      <rect x={W - pad - 16} y={headerY + 6} width={16} height={14} rx={rSm} fill={color.primary} />
      <Bar x={W - pad - 16 - 4 - 38} y={headerY + 8} w={38} h={5} fill={color.text} opacity={0.9} />
      <Bar x={W - pad - 16 - 4 - 28} y={headerY + 16} w={28} h={3} fill={color.textMuted} />
      <rect
        x={searchX}
        y={headerY + (headerH - searchH) / 2}
        width={searchW}
        height={searchH}
        rx={Math.max(rPill, 3)}
        fill={color.background}
        stroke={color.border}
        strokeWidth={1}
      />
      <Bar x={searchX + 8} y={headerY + headerH / 2 - 1.5} w={40} h={3} fill={color.textMuted} opacity={0.7} />
      <rect
        x={pad}
        y={headerY + (headerH - btnH) / 2}
        width={btnW}
        height={btnH}
        rx={Math.max(rPill, 3)}
        fill={color.primary}
      />
      <circle cx={pad + 3} cy={headerY + (headerH - btnH) / 2 + 1} r={3.2} fill={color.secondary} />
      <rect
        x={pad + btnW + 5}
        y={headerY + (headerH - btnH) / 2}
        width={btnW}
        height={btnH}
        rx={Math.max(rPill, 3)}
        fill="none"
        stroke={color.border}
        strokeWidth={1}
      />

      {/* ---- department bar: «كل المنتجات» + categories, one underlined ---- */}
      <rect x={0} y={catbarY} width={W} height={catbarH} fill={color.surface} opacity={0.6} />
      {[0, 1, 2, 3].map((i) => (
        <Bar
          key={i}
          x={W - pad - 26 - i * 34}
          y={catbarY + 4}
          w={26}
          h={3}
          fill={i === 0 ? color.primary : color.textMuted}
          opacity={i === 0 ? 1 : 0.8}
        />
      ))}
      <rect x={W - pad - 26} y={catbarY + catbarH - 1.5} width={26} height={1.5} fill={color.primary} />

      {/* ------------------------------- compact hero, one of three ------------------------------- */}
      {hero === 'split' && (
        <>
          <Bar x={W - pad - 110} y={heroY + 8} w={110} h={8} fill={color.text} opacity={0.9} />
          <Bar x={W - pad - 80} y={heroY + 20} w={80} h={4} fill={color.textMuted} />
          <rect x={W - pad - 46} y={heroY + 29} width={46} height={11} rx={rPill} fill={color.primary} />
          <rect
            x={W - pad - 46 - 5 - 40}
            y={heroY + 29}
            width={40}
            height={11}
            rx={rPill}
            fill="none"
            stroke={color.border}
            strokeWidth={1}
          />
          {(() => {
            const x = pad;
            const w = 86;
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
          <rect x={pad} y={heroY} width={inner} height={heroH} rx={rMd} fill={color.primary} opacity={0.9} />
          <Bar x={W - pad - 118} y={heroY + 10} w={104} h={8} fill={color.onPrimary} opacity={0.95} />
          <Bar x={W - pad - 118} y={heroY + 22} w={64} h={4} fill={color.onPrimary} opacity={0.7} />
          <rect
            x={W - pad - 118}
            y={heroY + 30}
            width={44}
            height={10}
            rx={rPill}
            fill={color.onPrimary}
            opacity={0.95}
          />
        </>
      )}

      {hero === 'ledger' && (
        <>
          <rect x={pad} y={heroY} width={inner} height={2.5} fill={color.primary} />
          <Bar x={W - pad - 120} y={heroY + 9} w={120} h={8} fill={color.text} opacity={0.9} />
          {[0, 1].map((row) => (
            <g key={row}>
              <Bar x={W - pad - 40} y={heroY + 24 + row * 9} w={40} h={3.5} fill={color.textMuted} />
              <Bar
                x={W - pad - 104}
                y={heroY + 24 + row * 9}
                w={56}
                h={3.5}
                fill={color.text}
                opacity={0.55}
              />
            </g>
          ))}
          <rect x={pad} y={heroY + 10} width={64} height={30} rx={rSm} fill={color.secondary} opacity={0.35} />
        </>
      )}

      {/* ---- category circles: the department row every commerce home opens with ---- */}
      {Array.from({ length: CIRCLES }, (_, i) => {
        const cx = W - pad - circleD / 2 - i * (circleD + 14);
        return (
          <g key={i}>
            <circle
              cx={cx}
              cy={circlesY + circleD / 2}
              r={circleD / 2}
              fill={color.primary}
              opacity={i === 0 ? 0.9 : 0.35}
              stroke={color.border}
              strokeWidth={1}
            />
            <Bar
              x={cx - 8}
              y={circlesY + circleD + 3}
              w={16}
              h={2.5}
              fill={color.textMuted}
            />
          </g>
        );
      })}
      {/* trust strip at the far end of the row — three small ticks */}
      {[0, 1, 2].map((i) => (
        <g key={i}>
          <circle cx={pad + 4 + i * 30} cy={circlesY + 6} r={3} fill={color.secondary} opacity={0.8} />
          <Bar x={pad + 10 + i * 30} y={circlesY + 4.5} w={16} h={3} fill={color.textMuted} />
        </g>
      ))}

      {/* --------------------- the product grid: four commerce cards --------------------- */}
      {Array.from({ length: GRID_COLUMNS }, (_, i) => {
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

            {/* `overlay`: name and price sit ON the picture, over a scrim; the button floats too. */}
            {productCard === 'overlay' && (
              <>
                <rect
                  x={x}
                  y={cardsY + cardsH - 30}
                  width={cardW}
                  height={30}
                  rx={rMd}
                  fill={color.background}
                  opacity={0.78}
                />
                <Bar
                  x={x + cardW - 5 - cardW * 0.6}
                  y={cardsY + cardsH - 26}
                  w={cardW * 0.6}
                  h={3.5}
                  fill={color.text}
                  opacity={0.9}
                />
                <Bar
                  x={x + cardW - 5 - cardW * 0.3}
                  y={cardsY + cardsH - 19}
                  w={cardW * 0.3}
                  h={3.5}
                  fill={color.primary}
                />
              </>
            )}

            {/* `framed` / `spec`: name, price bubble, then the full-width add-to-cart button. */}
            {productCard !== 'overlay' && (
              <>
                <Bar
                  x={x + cardW - 5 - cardW * 0.62}
                  y={cardsY + artH + 5}
                  w={cardW * 0.62}
                  h={3.5}
                  fill={color.text}
                  opacity={0.85}
                />
                {productCard === 'spec' ? (
                  <>
                    <Bar
                      x={x + cardW - 5 - cardW * 0.4}
                      y={cardsY + artH + 12}
                      w={cardW * 0.4}
                      h={2.5}
                      fill={color.textMuted}
                    />
                    <Bar
                      x={x + 5}
                      y={cardsY + artH + 12}
                      w={cardW * 0.28}
                      h={2.5}
                      fill={color.text}
                      opacity={0.5}
                    />
                  </>
                ) : (
                  <Bar
                    x={x + cardW - 5 - cardW * 0.8}
                    y={cardsY + artH + 12}
                    w={cardW * 0.8}
                    h={2.5}
                    fill={color.textMuted}
                  />
                )}
                <rect
                  x={x + cardW - 5 - 22}
                  y={cardsY + artH + 17}
                  width={22}
                  height={7}
                  rx={Math.max(rPill, 2)}
                  fill={color.primary}
                  opacity={0.18}
                />
                <Bar x={x + cardW - 5 - 18} y={cardsY + artH + 19} w={14} h={3} fill={color.primary} />
              </>
            )}

            <rect
              x={x + 4}
              y={btnY}
              width={cardW - 8}
              height={8}
              rx={Math.max(rPill, 2)}
              fill={color.primary}
              opacity={productCard === 'overlay' ? 0.95 : 1}
            />
            <Bar
              x={x + cardW / 2 - 8}
              y={btnY + 2.75}
              w={16}
              h={2.5}
              fill={color.onPrimary}
              opacity={0.95}
            />
          </g>
        );
      })}
    </svg>
  );
}
