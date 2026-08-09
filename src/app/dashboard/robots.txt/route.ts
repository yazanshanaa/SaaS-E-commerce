/** `app.{DOMAIN}/robots.txt` — the merchant dashboard is never indexed. See the admin twin. */
export const dynamic = 'force-static';

export function GET(): Response {
  return new Response('User-agent: *\nDisallow: /\n', {
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'x-robots-tag': 'noindex, nofollow',
    },
  });
}
