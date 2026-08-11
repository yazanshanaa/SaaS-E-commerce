import { can } from '@/server/entitlements';
import { exportTenantData, type ExportArtifact } from '@/server/export';
import type { MerchantContext } from './context';
import { audit } from './audit';

/**
 * The merchant's own copy of their catalogue — the احترافي self-serve button.
 *
 * It shares ONE contract with B1's suspension export and differs only in mode, and the
 * difference is the whole reason the mode exists (docs/PHASES.md, Q18):
 *
 *   - it writes under `tmp/`, which a cleanup job sweeps within 24h;
 *   - it is handed over through a short-lived signed URL, never a durable link;
 *   - and it NEVER touches the Subscription's export columns. A pro merchant pressing "تصدير"
 *     must not overwrite `exportKey` — that column is the artifact a SUSPENDED merchant was
 *     sent a link to, and clobbering it would break a 30-day promise from a button labelled
 *     "download my products".
 *
 * `data_export` gates this button and nothing else. The suspension export runs on every plan,
 * this flag included, which is why the check lives here rather than inside `exportTenantData`.
 */

export async function canSelfServeExport(ctx: MerchantContext): Promise<boolean> {
  // Owner-only: the export is the whole business in one file, and `staff` is products, orders
  // and media (Q13). `checkMerchantAccess` deliberately does not feature-gate the `export`
  // scope, because the suspension path must never consult a flag — so both halves are asked here.
  if (ctx.role !== 'owner') return false;
  return (await can(ctx.tenantId, 'data_export')) === true;
}

export interface SelfServeExport {
  artifact: ExportArtifact;
}

export async function runSelfServeExport(ctx: MerchantContext): Promise<SelfServeExport | null> {
  if (!(await canSelfServeExport(ctx))) return null;

  const artifact = await exportTenantData(ctx.tenantId, {
    mode: 'self_serve',
    actorUserId: ctx.userId,
    includeImages: true,
  });

  await audit(ctx, {
    action: 'export.self_serve',
    entityType: 'subscription',
    after: {
      // The KEY is recorded, never a signed URL: an audit row is read by people and kept for a
      // long time, and a credential in one is a credential in a backup.
      exportKey: artifact.key,
      sizeBytes: artifact.sizeBytes,
      contents: artifact.contents,
    },
  });

  return { artifact };
}

export type { ExportArtifact };
