/**
 * `admin.{DOMAIN}/robots.txt`.
 *
 * A route handler rather than a static `public/robots.txt`, because the platform serves four
 * hostname families from one app and they do not want the same answer: the storefront's file
 * is per tenant (A2, and a demo must be fully disallowed), while both private surfaces refuse
 * everything unconditionally. One static file at the root could only ever be right for one of
 * them — and being wrong for the storefront is how a demo tenant ends up in a search index.
 */
export const dynamic = 'force-static';

export function GET(): Response {
  return new Response('User-agent: *\nDisallow: /\n', {
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'x-robots-tag': 'noindex, nofollow',
    },
  });
}
