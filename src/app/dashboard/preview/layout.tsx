/**
 * The live preview's own layout (Phase 11, Track 11.D).
 *
 * Its ONE job is the stylesheets: the preview renders a real storefront document inside the app
 * surface, and the storefront's CSS arrives with the route the same way it arrives with
 * `src/app/site/layout.tsx` — one bundle, every template sheet, each namespaced under its own
 * `[data-template]` so nine sheets coexist. The list below must track the site layout's; the
 * template-sheet test walks only the site layout, so a key added there and forgotten here shows
 * up as an unstyled PREVIEW — annoying — rather than an unstyled shop.
 *
 * No chrome here and no `<main>`: the dashboard root layout already renders bare for the preview
 * header (see `../layout.tsx`), and `StorefrontShell` carries the page's single `main#main`.
 */

import '@/templates/storefront.css';
import '@/templates/diwan/diwan.css';
import '@/templates/neon-souq/neon-souq.css';
import '@/templates/warsheh/warsheh.css';
import '@/templates/bayt/bayt.css';
import '@/templates/raff/raff.css';
import '@/templates/aldar/aldar.css';
import '@/templates/matbakh/matbakh.css';
import '@/templates/mawid/mawid.css';
import '@/templates/jihaz/jihaz.css';

export default function PreviewLayout({ children }: { children: React.ReactNode }) {
  return children;
}
