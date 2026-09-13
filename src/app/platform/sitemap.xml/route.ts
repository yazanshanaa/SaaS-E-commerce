import { getEnv } from '@/env';

export function GET(): Response {
  const env = getEnv();
  const origin = `${env.PUBLIC_SCHEME}://${env.DOMAIN}`;
  const body =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    `  <url><loc>${origin}/</loc></url>\n` +
    `</urlset>\n`;
  return new Response(body, { headers: { 'content-type': 'application/xml; charset=utf-8' } });
}
