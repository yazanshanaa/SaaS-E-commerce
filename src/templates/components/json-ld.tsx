import { serialiseJsonLd, type JsonLd } from '../lib/seo';

/**
 * Structured data.
 *
 * `type="application/ld+json"` is inert — the browser never executes it — but the string still
 * has to be escaped, because a `</script>` inside a merchant's product description would close
 * the tag and turn the rest of the catalogue into markup. `serialiseJsonLd` escapes `<`.
 *
 * Callers must not render this for a demo or a suspended site: a rich snippet is the artefact
 * that survives longest after a page stops being crawlable, so it is exactly the wrong thing to
 * emit from a site that is noindex on three layers.
 */
export function JsonLdScript({ data }: { data: JsonLd }) {
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: serialiseJsonLd(data) }}
    />
  );
}
