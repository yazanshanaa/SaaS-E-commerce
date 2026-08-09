/**
 * The public storefront surface root — `{slug}.{DOMAIN}` and every verified custom domain.
 *
 * OWNED BY A2 (docs/PHASES.md calls this folder `src/app/(storefront)`).
 *
 * No `metadata` export here on purpose: unlike the two private surfaces, a storefront's title,
 * description, OG tags and robots directives are per tenant and A2 generates them from the
 * resolved context. Declaring a static default here would mean every merchant inherited it on
 * any page A2 had not yet overridden.
 */
export default function StorefrontSurfaceLayout({ children }: { children: React.ReactNode }) {
  return <div data-surface="storefront">{children}</div>;
}
