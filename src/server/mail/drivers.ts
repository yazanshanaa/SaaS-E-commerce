import { Resend } from 'resend';
import nodemailer, { type Transporter } from 'nodemailer';
import { getEnv } from '@/env';
import { logger } from '@/server/logger';
import { MailDeliveryError, type MailMessage, type MailResult, type MailService } from './types';
import { fromAddress } from './templates';

function recipients(message: MailMessage): string[] {
  const list = Array.isArray(message.to) ? message.to : [message.to];
  return list.map((r) => (r.name ? `${r.name} <${r.email}>` : r.email));
}

/**
 * Never log a recipient address or a subject that might contain a name — a mail log is a
 * contact list otherwise. Tag and driver are enough to correlate a failure.
 */
function logSend(driver: string, message: MailMessage, id: string | null): void {
  logger().info({ driver, tag: message.tag, id, count: recipients(message).length }, 'mail sent');
}

export class ResendMailService implements MailService {
  readonly driver = 'resend' as const;
  private client: Resend;

  constructor(apiKey: string) {
    this.client = new Resend(apiKey);
  }

  async send(message: MailMessage): Promise<MailResult> {
    const from = fromAddress();

    const { data, error } = await this.client.emails.send({
      from: `${from.name} <${from.email}>`,
      to: recipients(message),
      subject: message.subject,
      html: message.html,
      text: message.text,
      replyTo: message.replyTo ?? getEnv().MAIL_REPLY_TO,
      tags: message.tag ? [{ name: 'kind', value: message.tag }] : undefined,
    });

    if (error) {
      throw new MailDeliveryError(error.message, 'resend', error);
    }

    logSend('resend', message, data?.id ?? null);
    return { id: data?.id ?? null, driver: 'resend' };
  }
}

/**
 * The SMTP driver serves two roles: the production fallback when Resend is unavailable, and
 * the development driver pointed at mailpit — so a developer can verify that a password reset
 * actually arrives, which is the acceptance bar for this phase.
 */
export class SmtpMailService implements MailService {
  readonly driver = 'smtp' as const;
  private transporter: Transporter;

  constructor() {
    const env = getEnv();
    this.transporter = nodemailer.createTransport({
      host: env.SMTP_HOST ?? 'localhost',
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE,
      auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASSWORD ?? '' } : undefined,
      // mailpit speaks plain SMTP with no auth; refusing self-signed certs there is noise.
      tls: env.NODE_ENV === 'development' ? { rejectUnauthorized: false } : undefined,
    });
  }

  async send(message: MailMessage): Promise<MailResult> {
    const from = fromAddress();

    try {
      const info = await this.transporter.sendMail({
        from: { address: from.email, name: from.name },
        to: recipients(message),
        subject: message.subject,
        html: message.html,
        text: message.text,
        replyTo: message.replyTo ?? getEnv().MAIL_REPLY_TO,
        headers: {
          // RTL hint for clients that honour it; the templates set dir on the markup too.
          'Content-Language': 'ar',
          ...(message.tag ? { 'X-Souq-Tag': message.tag } : {}),
        },
      });

      logSend('smtp', message, info.messageId ?? null);
      return { id: info.messageId ?? null, driver: 'smtp' };
    } catch (error) {
      throw new MailDeliveryError(
        error instanceof Error ? error.message : 'SMTP send failed',
        'smtp',
        error,
      );
    }
  }
}

/**
 * Resend with an automatic SMTP fallback. A password-reset email that does not arrive because
 * one provider had a bad afternoon is an account lockout, so the fallback is wired rather than
 * documented.
 */
export class FallbackMailService implements MailService {
  readonly driver = 'resend' as const;

  constructor(
    private primary: MailService,
    private fallback: MailService,
  ) {}

  async send(message: MailMessage): Promise<MailResult> {
    try {
      return await this.primary.send(message);
    } catch (error) {
      logger().warn(
        { tag: message.tag, driver: this.primary.driver },
        'primary mail driver failed, falling back to SMTP',
      );
      void error;
      return this.fallback.send(message);
    }
  }
}
