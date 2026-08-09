import { NextResponse, type NextRequest } from 'next/server';
import { recordExportDownload, resolveExportDownload } from '@/server/export';
import { logger } from '@/server/logger';
import { t } from '@/shared/i18n';

/**
 * `app.{DOMAIN}/export/{token}` — the Q18 handover.
 *
 * On the unauthenticated allow-list in proxy.ts, because a suspended merchant opens it from a
 * WhatsApp message on the day their site went dark. Requiring a session here would make the
 * promise unkeepable for exactly the person it exists for.
 *
 * It NEVER redirects to a long-lived storage URL. It resolves the token, writes an audit row
 * with getClientIp(), stamps the first download, mints a ≤1h signed URL at request time, and
 * streams the bytes through. A presigned URL handed to the browser would be un-revocable and
 * un-auditable — and would expire at 7 days against a 30-day promise.
 */
export const dynamic = 'force-dynamic';

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ token: string }> },
): Promise<Response> {
  const { token } = await context.params;

  const resolved = await resolveExportDownload(token);

  if (!resolved.ok) {
    const copy =
      resolved.reason === 'not_ready'
        ? { title: t('common', 'export.notReady.title'), body: t('common', 'export.notReady.body') }
        : {
            title: t('common', 'export.invalidToken.title'),
            body: t('common', 'export.invalidToken.body'),
          };

    return new NextResponse(page(copy.title, copy.body), {
      status: resolved.reason === 'not_ready' ? 409 : 404,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'x-robots-tag': 'noindex, nofollow',
      },
    });
  }

  const { signedUrl } = await recordExportDownload(resolved, {
    headers: request.headers,
    socketIp: request.headers.get('x-real-ip'),
  });

  const upstream = await fetch(signedUrl);
  if (!upstream.ok || !upstream.body) {
    logger().error({ tenantId: resolved.tenantId }, 'export artifact unreadable at download time');
    return new NextResponse(
      page(t('common', 'export.notReady.title'), t('common', 'export.notReady.body')),
      { status: 502, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } },
    );
  }

  const filename = `souq-bartaa-${resolved.tenantId}.zip`;

  return new NextResponse(upstream.body, {
    status: 200,
    headers: {
      'content-type': 'application/zip',
      'content-disposition': `attachment; filename="${filename}"`,
      'cache-control': 'no-store, max-age=0',
      'x-robots-tag': 'noindex, nofollow',
    },
  });
}

/** A tiny standalone Arabic page: this route must answer even when nothing else is reachable. */
function page(title: string, body: string): string {
  const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<!doctype html>
<html lang="ar" dir="rtl">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex, nofollow" />
    <title>${escape(title)}</title>
    <style>
      body { margin:0; background:#faf7f1; color:#241c14; font-family:'Segoe UI',Tahoma,sans-serif; line-height:1.8; }
      .wrap { min-height:100dvh; display:flex; align-items:center; justify-content:center; padding:32px 16px; }
      .card { max-width:34rem; background:#fff; border:1px solid #e3d9c8; border-radius:18px; padding:32px; }
      h1 { font-size:1.6rem; margin:0 0 12px; }
      p { margin:0; color:#6b5d4d; }
    </style>
  </head>
  <body>
    <div class="wrap"><div class="card"><h1>${escape(title)}</h1><p>${escape(body)}</p></div></div>
  </body>
</html>`;
}
