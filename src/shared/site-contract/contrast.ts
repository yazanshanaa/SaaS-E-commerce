/**
 * The WCAG AA contrast guard.
 *
 * Tenant colour customisation writes tokens only, and every write passes through here. When a
 * chosen pair fails, we do NOT reject it: we walk the lightness of the foreground until it
 * passes and tell the merchant what we changed. A hard rejection would leave a shop owner
 * staring at a colour picker with no idea which of six sliders to move.
 *
 * AA thresholds: 4.5:1 for body text, 3:1 for large text and non-text UI (WCAG 2.0, which is
 * what IS 5568 references).
 */

export const AA_NORMAL = 4.5;
export const AA_LARGE = 3;

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

export function isHexColor(value: string): boolean {
  return HEX.test(value.trim());
}

export function hexToRgb(hex: string): Rgb {
  const clean = hex.trim().replace('#', '');
  const full =
    clean.length === 3
      ? clean
          .split('')
          .map((c) => c + c)
          .join('')
      : clean;

  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16),
  };
}

export function rgbToHex({ r, g, b }: Rgb): string {
  const part = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
  return `#${part(r)}${part(g)}${part(b)}`;
}

function channelLuminance(value: number): number {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance(color: string | Rgb): number {
  const { r, g, b } = typeof color === 'string' ? hexToRgb(color) : color;
  return 0.2126 * channelLuminance(r) + 0.7152 * channelLuminance(g) + 0.0722 * channelLuminance(b);
}

export function contrastRatio(a: string | Rgb, b: string | Rgb): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

// --- HSL, for the adjustment walk -------------------------------------------

export interface Hsl {
  h: number;
  s: number;
  l: number;
}

export function rgbToHsl({ r, g, b }: Rgb): Hsl {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;

  if (max === min) return { h: 0, s: 0, l };

  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6;
  else if (max === gn) h = ((bn - rn) / d + 2) / 6;
  else h = ((rn - gn) / d + 4) / 6;

  return { h, s, l };
}

export function hslToRgb({ h, s, l }: Hsl): Rgb {
  if (s === 0) {
    const v = l * 255;
    return { r: v, g: v, b: v };
  }

  const hue = (p: number, q: number, tRaw: number): number => {
    let tt = tRaw;
    if (tt < 0) tt += 1;
    if (tt > 1) tt -= 1;
    if (tt < 1 / 6) return p + (q - p) * 6 * tt;
    if (tt < 1 / 2) return q;
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
    return p;
  };

  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;

  return {
    r: hue(p, q, h + 1 / 3) * 255,
    g: hue(p, q, h) * 255,
    b: hue(p, q, h - 1 / 3) * 255,
  };
}

export interface ContrastResult {
  /** The colour to actually store — the input if it already passed. */
  color: string;
  ratio: number;
  passes: boolean;
  adjusted: boolean;
  /** Arabic, ready to show. Null when nothing was changed. */
  noticeKey: 'contrastAdjusted' | null;
}

/**
 * Bring `foreground` up to `target` against `background` by moving its lightness, keeping hue
 * and saturation so the merchant's colour still looks like the colour they picked.
 *
 * Walks toward whichever end of the lightness scale the background is furthest from — pushing
 * a dark text colour darker against a dark background would never converge.
 */
export function ensureContrast(
  foreground: string,
  background: string,
  target: number = AA_NORMAL,
): ContrastResult {
  const initial = contrastRatio(foreground, background);
  if (initial >= target) {
    return { color: foreground, ratio: initial, passes: true, adjusted: false, noticeKey: null };
  }

  const hsl = rgbToHsl(hexToRgb(foreground));
  const backgroundIsDark = relativeLuminance(background) < 0.5;
  const step = backgroundIsDark ? 0.02 : -0.02;

  let best = foreground;
  let bestRatio = initial;

  for (let i = 1; i <= 50; i += 1) {
    const l = Math.max(0, Math.min(1, hsl.l + step * i));
    const candidate = rgbToHex(hslToRgb({ ...hsl, l }));
    const ratio = contrastRatio(candidate, background);

    if (ratio > bestRatio) {
      best = candidate;
      bestRatio = ratio;
    }
    if (ratio >= target) {
      return { color: candidate, ratio, passes: true, adjusted: true, noticeKey: 'contrastAdjusted' };
    }
    if (l === 0 || l === 1) break;
  }

  // Pure black or pure white is the last resort — it always passes against something.
  const fallback = backgroundIsDark ? '#ffffff' : '#000000';
  const fallbackRatio = contrastRatio(fallback, background);
  if (fallbackRatio > bestRatio) {
    return {
      color: fallback,
      ratio: fallbackRatio,
      passes: fallbackRatio >= target,
      adjusted: true,
      noticeKey: 'contrastAdjusted',
    };
  }

  return {
    color: best,
    ratio: bestRatio,
    passes: bestRatio >= target,
    adjusted: best !== foreground,
    noticeKey: best !== foreground ? 'contrastAdjusted' : null,
  };
}
