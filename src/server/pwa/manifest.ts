/**
 * The web app manifest, per tenant, in Arabic.
 *
 * There is no static `manifest.json` on this platform and there cannot be one: every field in it
 * is the merchant's — their shop's name, their colours, their icon. A shared file would install
 * one merchant's shop on another merchant's customer's home screen under the platform's name,
 * which is the opposite of what this product sells.
 *
 * `lang: 'ar'` and `dir: 'rtl'` are not decoration either. They are what makes Android render the
 * app name correctly in the launcher and in the install prompt; without them a name containing
 * both Arabic and a Latin word (half the shops in Bartaa) reorders on screen.
 */

export interface ManifestInput {
  name: string;
  tagline: string | null;
  /** Resolved tokens, already through the contrast guard. */
  themeColor: string;
  backgroundColor: string;
}

export interface WebAppManifest {
  name: string;
  short_name: string;
  description?: string;
  lang: string;
  dir: 'rtl';
  start_url: string;
  scope: string;
  display: string;
  orientation: string;
  theme_color: string;
  background_color: string;
  icons: Array<{ src: string; sizes: string; type: string; purpose?: string }>;
}

/**
 * Android truncates a launcher label at roughly a dozen characters, and truncating a shop's name
 * mid-word looks like a bug rather than a limit. Cutting at a word boundary keeps it a name.
 */
const SHORT_NAME_MAX = 12;

export function shortName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length <= SHORT_NAME_MAX) return trimmed;

  const cut = trimmed.slice(0, SHORT_NAME_MAX);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > 3 ? cut.slice(0, lastSpace) : cut).trim();
}

export function buildManifest(input: ManifestInput): WebAppManifest {
  return {
    name: input.name,
    short_name: shortName(input.name),
    ...(input.tagline ? { description: input.tagline } : {}),
    lang: 'ar',
    dir: 'rtl',
    /**
     * RELATIVE, not absolute. The same tenant answers on `{slug}.{DOMAIN}` and on their custom
     * domain, and an absolute `start_url` baked from either one would install an app that opens
     * the OTHER hostname — so a merchant who later connects a domain would have every already-
     * installed customer still landing on the platform subdomain. A relative URL resolves against
     * whichever origin served the manifest, which is always the one the visitor is on.
     */
    start_url: '/',
    scope: '/',
    /**
     * `standalone`, not `fullscreen`: a shop needs the status bar (the clock and the battery are
     * how a customer knows their phone is still a phone) and does not need to hide it.
     */
    display: 'standalone',
    orientation: 'portrait',
    theme_color: input.themeColor,
    background_color: input.backgroundColor,
    icons: [
      { src: '/icons/192', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/512', sizes: '512x512', type: 'image/png', purpose: 'any' },
      // Declared separately rather than as `purpose: 'any maskable'` on one entry: the two are
      // genuinely different pictures here (see `renderPwaIcon`), and a combined purpose would let
      // a launcher crop the un-inset artwork.
      { src: '/icons/maskable', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
