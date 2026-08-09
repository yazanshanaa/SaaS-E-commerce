// src/server/demo/placeholder.ts — SVG placeholder generator for demo products (zero dependencies)
// Usage: svgPlaceholder('clothing', 'عباية مطرزة كلاسيك', 'cl-01')
// Then feed the result into the A3 media pipeline: sharp(Buffer.from(svg)).resize(...).webp()
//
// IMPORTANT for the Docker image: librsvg (used by Sharp to rasterize SVG) relies on system fonts.
// Install an Arabic-capable font in the runtime image or Arabic text renders as boxes:
//   RUN apt-get install -y --no-install-recommends fonts-noto-core
// The font referenced below is "Noto Sans Arabic".

export type PackKey = 'clothing' | 'industrial' | 'food';

const PALETTES: Record<PackKey, { bg: string; fg: string; accent: string }> = {
  clothing:   { bg: '#141018', fg: '#F7EDF1', accent: '#E11D48' },
  industrial: { bg: '#171B21', fg: '#EDEFF2', accent: '#F59E0B' },
  food:       { bg: '#FAF3E7', fg: '#3D2B1F', accent: '#C2410C' },
};

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Wrap the product name onto two or three lines so it never overflows the frame
function wrap(name: string, maxChars = 16): string[] {
  const words = name.trim().split(/\s+/);
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    if ((cur + ' ' + w).trim().length > maxChars && cur) {
      lines.push(cur);
      cur = w;
    } else {
      cur = cur ? cur + ' ' + w : w;
    }
  }
  if (cur) lines.push(cur);
  return lines.slice(0, 3);
}

export function svgPlaceholder(pack: PackKey, name: string, sku: string): string {
  const p = PALETTES[pack];
  const size = 1200;
  const lines = wrap(name);
  const lineH = 100;
  const startY = size / 2 - ((lines.length - 1) * lineH) / 2 + 24;
  const text = lines
    .map(
      (l, i) =>
        `<text x="600" y="${startY + i * lineH}" text-anchor="middle" direction="rtl" ` +
        `font-family="'Noto Sans Arabic', sans-serif" font-size="78" font-weight="700" ` +
        `fill="${p.fg}">${esc(l)}</text>`,
    )
    .join('\n  ');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" fill="${p.bg}"/>
  <circle cx="1010" cy="180" r="240" fill="${p.accent}" opacity="0.16"/>
  <circle cx="170" cy="1030" r="300" fill="${p.accent}" opacity="0.10"/>
  <rect x="80" y="80" width="1040" height="1040" fill="none" stroke="${p.accent}" stroke-opacity="0.35" stroke-width="3" rx="28"/>
  ${text}
  <text x="600" y="1096" text-anchor="middle" font-family="monospace" font-size="30" fill="${p.fg}" opacity="0.45">${esc(sku)}</text>
</svg>`;
}
