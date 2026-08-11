import pino from 'pino';
import { getEnv } from '@/env';

/**
 * Structured logging with mandatory redaction.
 *
 * Item 13's rule, encoded once so nobody has to remember it: an event payload may carry links
 * and identifiers that reach a third party (n8n stores node input and output in its execution
 * history, and Q9 puts that database in the backup set). So payload fields are redacted in
 * application logs and scrubbed from Sentry, never rendered raw in admin surfaces, and no
 * payload may ever contain a credential that grants standing access to tenant data.
 *
 * That last rule is why Q18's `subscription.suspended` event carries a revocable platform link
 * rather than a signed storage URL: a signed URL in a log line is a working credential sitting
 * in a backup.
 */

const REDACTED_PATHS = [
  'payload',
  '*.payload',
  'password',
  '*.password',
  'token',
  '*.token',
  'secret',
  '*.secret',
  'exportDownloadToken',
  '*.exportDownloadToken',
  'signedUrl',
  '*.signedUrl',
  'credentials',
  '*.credentials',
  'authorization',
  'req.headers.authorization',
  'req.headers.cookie',
  'whatsapp',
  '*.whatsapp',
  'ip',
  '*.ip',
  'ipHash',
  '*.ipHash',
  /**
   * Phase 5. Two new shapes enter the process on the day checkout ships:
   *
   *   - a gateway settlement notice (`rawPayload`), which is a third party's body and may carry
   *     anything from a card mask to a customer's email;
   *   - a storefront customer's name and phone, which is the first real customer PII this
   *     platform has ever held (Q5 held none).
   *
   * Neither belongs in a log line. `customerPhone` is the one that would actually leak: it is
   * carried through the checkout route, the order service and the dashboard, and a single
   * `logger().info({ order })` anywhere on that path would put a stranger's number in a file
   * nobody has a retention rule for.
   */
  'rawPayload',
  '*.rawPayload',
  'customerName',
  '*.customerName',
  'customerPhone',
  '*.customerPhone',
  'customerNote',
  '*.customerNote',
];

let instance: pino.Logger | undefined;

export function logger(): pino.Logger {
  if (instance) return instance;

  const env = getEnv();
  instance = pino({
    level: env.LOG_LEVEL,
    redact: { paths: REDACTED_PATHS, censor: '[redacted]' },
    base: { service: 'souq-bartaa' },
    transport:
      env.NODE_ENV === 'development'
        ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } }
        : undefined,
  });

  return instance;
}

/**
 * What may be attached to a log line about an event: its type and its identity, never its
 * body. Use this instead of spreading an event object into a logger call.
 */
export function eventLogFields(event: { id: string; type: string; tenantId?: string | null }) {
  return { eventId: event.id, eventType: event.type, tenantId: event.tenantId ?? undefined };
}
