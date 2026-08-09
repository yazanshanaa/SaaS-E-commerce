import { t } from '@/shared/i18n';
import { getEnv } from '@/env';

/**
 * Arabic, RTL email templates.
 *
 * Deliberately table-based with inline styles: every serious mail client strips <style>
 * blocks, ignores flexbox, and half of them ignore `dir` on anything but the outermost
 * element. `dir="rtl"` is set on the html element AND on each text cell, because Outlook
 * resets direction per table cell.
 *
 * Every string comes from messages/ar/common.json — an email is a user-facing surface and the
 * language gate applies to it exactly as it does to a page.
 */

interface Layout {
  heading: string;
  body: string;
  ctaLabel: string;
  ctaHref: string;
  footnote?: string;
  greetingName?: string;
}

const BRAND = {
  background: '#FAF3E7',
  surface: '#FFFFFF',
  text: '#2B2118',
  muted: '#6B5D50',
  primary: '#C2410C',
  border: '#E7DCC9',
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function layout(content: Layout): string {
  const appName = t('common', 'app.name');
  const greeting = content.greetingName
    ? `<p style="margin:0 0 12px;font-size:16px;color:${BRAND.text};" dir="rtl">${escapeHtml(
        t('common', 'email.greeting', { name: content.greetingName }),
      )}</p>`
    : '';

  return `<!doctype html>
<html lang="ar" dir="rtl">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(content.heading)}</title>
  </head>
  <body style="margin:0;padding:0;background:${BRAND.background};">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BRAND.background};padding:24px 12px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:${BRAND.surface};border:1px solid ${BRAND.border};border-radius:12px;overflow:hidden;">
            <tr>
              <td dir="rtl" style="padding:24px 28px 8px;font-family:'Segoe UI',Tahoma,Arial,sans-serif;text-align:right;">
                <div style="font-size:18px;font-weight:700;color:${BRAND.primary};">${escapeHtml(appName)}</div>
              </td>
            </tr>
            <tr>
              <td dir="rtl" style="padding:8px 28px 4px;font-family:'Segoe UI',Tahoma,Arial,sans-serif;text-align:right;">
                <h1 style="margin:0 0 12px;font-size:22px;line-height:1.5;color:${BRAND.text};">${escapeHtml(content.heading)}</h1>
                ${greeting}
                <p style="margin:0 0 20px;font-size:16px;line-height:1.8;color:${BRAND.text};">${escapeHtml(content.body)}</p>
              </td>
            </tr>
            <tr>
              <td dir="rtl" align="right" style="padding:0 28px 20px;font-family:'Segoe UI',Tahoma,Arial,sans-serif;">
                <a href="${escapeHtml(content.ctaHref)}" style="display:inline-block;background:${BRAND.primary};color:#FFFFFF;text-decoration:none;font-size:16px;font-weight:600;padding:12px 24px;border-radius:8px;">${escapeHtml(content.ctaLabel)}</a>
              </td>
            </tr>
            ${
              content.footnote
                ? `<tr><td dir="rtl" style="padding:0 28px 16px;font-family:'Segoe UI',Tahoma,Arial,sans-serif;text-align:right;"><p style="margin:0;font-size:14px;line-height:1.7;color:${BRAND.muted};">${escapeHtml(content.footnote)}</p></td></tr>`
                : ''
            }
            <tr>
              <td dir="rtl" style="padding:0 28px 24px;font-family:'Segoe UI',Tahoma,Arial,sans-serif;text-align:right;">
                <p style="margin:0 0 6px;font-size:13px;line-height:1.7;color:${BRAND.muted};">${escapeHtml(t('common', 'email.fallbackLink'))}</p>
                <p style="margin:0;font-size:13px;line-height:1.7;color:${BRAND.muted};word-break:break-all;" dir="ltr">${escapeHtml(content.ctaHref)}</p>
              </td>
            </tr>
            <tr>
              <td dir="rtl" style="padding:16px 28px;border-top:1px solid ${BRAND.border};font-family:'Segoe UI',Tahoma,Arial,sans-serif;text-align:right;">
                <p style="margin:0 0 4px;font-size:13px;color:${BRAND.muted};">${escapeHtml(t('common', 'email.signature'))}</p>
                <p style="margin:0;font-size:12px;color:${BRAND.muted};">${escapeHtml(t('common', 'email.footerNote'))}</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

function plainText(content: Layout): string {
  return [
    content.greetingName ? t('common', 'email.greeting', { name: content.greetingName }) : '',
    content.heading,
    '',
    content.body,
    '',
    `${content.ctaLabel}: ${content.ctaHref}`,
    content.footnote ?? '',
    '',
    t('common', 'email.signature'),
  ]
    .filter(Boolean)
    .join('\n');
}

export interface RenderedMail {
  subject: string;
  html: string;
  text: string;
}

function render(subject: string, content: Layout): RenderedMail {
  return { subject, html: layout(content), text: plainText(content) };
}

/** Verification link expiry, in hours, quoted in the copy so it is never a silent surprise. */
const VERIFY_HOURS = 24;
const RESET_HOURS = 1;

export function verifyEmailTemplate(params: { name: string; url: string }): RenderedMail {
  return render(t('common', 'email.verify.subject'), {
    greetingName: params.name,
    heading: t('common', 'email.verify.heading'),
    body: t('common', 'email.verify.body'),
    ctaLabel: t('common', 'email.verify.cta'),
    ctaHref: params.url,
    footnote: `${t('common', 'email.verify.expiry', { hours: VERIFY_HOURS })} ${t('common', 'email.ignoreNote')}`,
  });
}

export function resetPasswordTemplate(params: { name: string; url: string }): RenderedMail {
  return render(t('common', 'email.reset.subject'), {
    greetingName: params.name,
    heading: t('common', 'email.reset.heading'),
    body: t('common', 'email.reset.body'),
    ctaLabel: t('common', 'email.reset.cta'),
    ctaHref: params.url,
    footnote: `${t('common', 'email.reset.expiry', { hours: RESET_HOURS })} ${t('common', 'email.ignoreNote')}`,
  });
}

export function staffInviteTemplate(params: {
  tenantName: string;
  inviterName: string;
  url: string;
}): RenderedMail {
  return render(t('common', 'email.invite.subject', { tenant: params.tenantName }), {
    heading: t('common', 'email.invite.heading', { tenant: params.tenantName }),
    body: t('common', 'email.invite.body', {
      inviter: params.inviterName,
      tenant: params.tenantName,
    }),
    ctaLabel: t('common', 'email.invite.cta'),
    ctaHref: params.url,
  });
}

export function fromAddress(): { email: string; name: string } {
  const env = getEnv();
  return { email: env.MAIL_FROM, name: env.MAIL_FROM_NAME };
}
