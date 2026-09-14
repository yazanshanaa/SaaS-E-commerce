import { getEnv } from '@/env';

/** The one surface that wants to be indexed. */
export function GET(): Response {
  const env = getEnv();
  const body = ['User-agent: *', 'Allow: /', `Sitemap: ${env.PUBLIC_SCHEME}://${env.DOMAIN}/sitemap.xml`, ''].join('\n');
  return new Response(body, { headers: { 'content-type': 'text/plain; charset=utf-8' } });
}
