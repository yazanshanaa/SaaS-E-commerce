import { z } from 'zod';
import { mailService } from '@/server/mail';
import type { TenantJob } from '@/server/queues';
import type { TenantTx } from '@/server/db';

/**
 * Transactional mail as a TenantJob.
 *
 * Sending inside the request that caused it would tie a merchant-visible action to a third
 * party's availability; sending from a job means a Resend outage delays a message instead of
 * failing a suspension.
 *
 * The body is rendered by the caller and passed in, so this processor never has to know which
 * template it is sending — and never has to look up a recipient it was not given.
 */
const payloadSchema = z.object({
  to: z.object({ email: z.email(), name: z.string().optional() }),
  subject: z.string().min(1),
  html: z.string().min(1),
  text: z.string().min(1),
  tag: z.string().optional(),
});

export default async function process(ctx: {
  job: TenantJob;
  tx: TenantTx;
}): Promise<{ id: string | null }> {
  const payload = payloadSchema.parse(ctx.job.data);

  const result = await mailService().send({
    to: payload.to,
    subject: payload.subject,
    html: payload.html,
    text: payload.text,
    tag: payload.tag,
  });

  return { id: result.id };
}
