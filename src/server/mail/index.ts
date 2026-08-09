import { getEnv } from '@/env';
import { FallbackMailService, ResendMailService, SmtpMailService } from './drivers';
import type { MailMessage, MailResult, MailService } from './types';

let instance: MailService | undefined;

/**
 * The single mail entry point.
 *
 * MAIL_DRIVER=resend gives Resend with an SMTP fallback; MAIL_DRIVER=smtp gives SMTP alone,
 * which is what development uses (mailpit on :1025) so nothing ever escapes the machine.
 */
export function mailService(): MailService {
  if (instance) return instance;

  const env = getEnv();

  if (env.MAIL_DRIVER === 'resend') {
    if (!env.RESEND_API_KEY) {
      throw new Error('MAIL_DRIVER=resend requires RESEND_API_KEY.');
    }
    instance = new FallbackMailService(new ResendMailService(env.RESEND_API_KEY), new SmtpMailService());
  } else {
    instance = new SmtpMailService();
  }

  return instance;
}

/** Tests replace the service rather than the network. */
export function setMailService(service: MailService | undefined): void {
  instance = service;
}

export type { MailMessage, MailResult, MailService };
export { MailDeliveryError } from './types';
export {
  verifyEmailTemplate,
  resetPasswordTemplate,
  staffInviteTemplate,
  type RenderedMail,
} from './templates';
export { ResendMailService, SmtpMailService, FallbackMailService } from './drivers';
