import { translator } from '@/shared/i18n';

/**
 * Bound translators for the storefront.
 *
 * Every string a visitor reads comes through one of these — including Arabic ones. A hardcoded
 * Arabic literal in a component is as much a failure as an English one: the i18n layer cannot
 * reach it, so a second locale would have to hunt through JSX to find it (CLAUDE.md).
 *
 * SERVER SIDE ONLY. Importing `@/shared/i18n` into a client component would pull all seven
 * message namespaces — admin, dashboard, billing and the rest — into the storefront bundle, on
 * a page with a Fast 3G LCP budget. Client components receive already-translated labels as
 * props instead; see `components/announcement-bar.tsx` for the pattern.
 */
export const st = translator('storefront');
export const ct = translator('common');
