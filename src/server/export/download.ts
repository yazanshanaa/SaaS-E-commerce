import { publicDb, withTenantTxn } from '@/server/db';
import { storage, MAX_SIGNED_URL_TTL_SECONDS } from '@/server/storage';
import { getClientIp, type ClientIpInput } from '@/server/http/get-client-ip';
import { logger } from '@/server/logger';
import { getEnv } from '@/env';

/**
 * The `/export/{token}` handover (Q18).
 *
 * Why this is a platform route and not a presigned storage URL, stated where the code lives:
 * SigV4 caps presigned validity at 7 days and R2 enforces the S3 limit, so a 30-day promise
 * built on a presign dies silently on day 8 — for the merchant most likely to need it, the one
 * who waited. Worse, a presign cannot be revoked and cannot be audited, so reactivation could
 * not take the copy back and nobody could ever answer "was my data downloaded, and by whom".
 *
 * The route therefore does four things in order, and the order matters:
 *   1. resolve the token against a LIVE suspended subscription still inside retentionUntil,
 *   2. write an AuditLog row with getClientIp(),
 *   3. stamp exportFirstDownloadedAt,
 *   4. mint a ≤1h signed URL AT REQUEST TIME and stream through it.
 *
 * Never redirect to a long-lived storage URL: that would hand out exactly the un-revocable,
 * un-auditable credential this design exists to avoid.
 */

export type ExportDownloadFailure = 'invalid_token' | 'not_ready';

export interface ExportDownload {
  ok: true;
  tenantId: string;
  subscriptionId: string;
  exportKey: string;
  retentionUntil: Date;
  alreadyDownloaded: boolean;
}

export interface ExportDownloadRejection {
  ok: false;
  reason: ExportDownloadFailure;
}

/**
 * Step 1, run with NO tenant context — a suspended merchant opens this from WhatsApp with no
 * session at all. The narrow `subscription_export_token_lookup` policy in migration 0001 is
 * what makes exactly this one row visible, and only while the token is live, the subscription
 * is suspended, and the retention window is open.
 */
export async function resolveExportDownload(
  token: string,
): Promise<ExportDownload | ExportDownloadRejection> {
  if (!token || token.length < 20) {
    return { ok: false, reason: 'invalid_token' };
  }

  const subscription = await publicDb().subscription.findFirst({
    where: { exportDownloadToken: token },
    select: {
      id: true,
      tenantId: true,
      exportKey: true,
      exportFirstDownloadedAt: true,
      retentionUntil: true,
    },
  });

  if (!subscription || !subscription.retentionUntil) {
    return { ok: false, reason: 'invalid_token' };
  }

  if (!subscription.exportKey) {
    // The suspension committed but the export job has not finished. Never promise a copy that
    // does not exist — B1 only sends the message after the artifact is written.
    return { ok: false, reason: 'not_ready' };
  }

  return {
    ok: true,
    tenantId: subscription.tenantId,
    subscriptionId: subscription.id,
    exportKey: subscription.exportKey,
    retentionUntil: subscription.retentionUntil,
    alreadyDownloaded: subscription.exportFirstDownloadedAt !== null,
  };
}

/**
 * Steps 2–4. Runs inside the tenant's own context so the audit row lands in the tenant's audit
 * trail — where it dies with the tenant on purge, exactly like the rest of their data.
 */
export async function recordExportDownload(
  download: ExportDownload,
  request: ClientIpInput,
): Promise<{ signedUrl: string }> {
  const { ip } = getClientIp(request);
  const ttl = Math.min(getEnv().EXPORT_SIGNED_URL_TTL_SECONDS, MAX_SIGNED_URL_TTL_SECONDS);

  await withTenantTxn(download.tenantId, async (tx) => {
    await tx.auditLog.create({
      data: {
        tenantId: download.tenantId,
        actorUserId: null,
        actorRole: 'public',
        action: 'export.downloaded',
        entityType: 'subscription',
        entityId: download.subscriptionId,
        after: { exportKey: download.exportKey },
        ip,
        userAgent: request.headers.get('user-agent'),
      },
    });

    // First download only: the tombstone records WHETHER the merchant ever collected it, which
    // is the platform's defence if they later say they never got a copy.
    if (!download.alreadyDownloaded) {
      await tx.subscription.update({
        where: { id: download.subscriptionId },
        data: { exportFirstDownloadedAt: new Date() },
      });
    }
  });

  const signedUrl = await storage().signedUrl(download.exportKey, ttl);

  logger().info(
    { tenantId: download.tenantId, first: !download.alreadyDownloaded },
    'export download authorised',
  );

  return { signedUrl };
}
