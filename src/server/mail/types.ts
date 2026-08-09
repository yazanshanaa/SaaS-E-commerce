/**
 * ONE interface, two drivers. Nothing in the platform sends mail except through this.
 *
 * Resend is the production primary; SMTP is both the documented fallback (a provider outage
 * must not take password resets down with it) and the development driver, pointed at mailpit
 * so no dev email ever leaves the machine.
 */

export interface MailAddress {
  email: string;
  name?: string;
}

export interface MailMessage {
  to: MailAddress | MailAddress[];
  subject: string;
  html: string;
  /** Always provide one: a mail client that cannot render HTML must still show the link. */
  text: string;
  replyTo?: string;
  /** Correlates a send with the action that caused it, without logging the recipient. */
  tag?: string;
}

export interface MailResult {
  id: string | null;
  driver: 'resend' | 'smtp';
}

export interface MailService {
  readonly driver: 'resend' | 'smtp';
  send(message: MailMessage): Promise<MailResult>;
}

export class MailDeliveryError extends Error {
  constructor(
    message: string,
    readonly driver: 'resend' | 'smtp',
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'MailDeliveryError';
  }
}
