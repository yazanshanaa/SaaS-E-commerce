import { demoStorefrontUrl } from '@/server/billing';
import { superAdminDb, type Actor } from '@/server/db';
import { HOME_PAGE_SLUG, TEMPLATES, isTemplateKey } from '@/shared/site-contract';
import type { PackKey } from './types';

/**
 * What the demo list reads.
 *
 * DEMOS NEVER EXPIRE ON A TIMER (Q2): the magic link has no expiry by default, and a demo carries
 * `currentPeriodEnd = null`, so nothing in B1's sweep will ever touch one. That is the right
 * behaviour during a sales conversation and the wrong behaviour six months later, when a forgotten
 * demo is still serving a prospect's phone number to anyone holding an old link. The only thing
 * standing between those two is this screen, which is why AGE is a first-class column rather than a
 * detail on a tab: it is the whole mechanism by which a forgotten demo surfaces.
 */

export interface DemoListRow {
  tenantId: string;
  name: string;
  slug: string;
  createdAt: Date;
  /** Whole days since creation — the column that makes a forgotten demo visible. */
  ageDays: number;
  /** Arabic template name; see the note in `packOf` for why the pack itself is not always known. */
  templateName: string;
  packKey: PackKey | null;
  productCount: number;
  /** The live magic link, or null when every token has been revoked or has expired. */
  demoUrl: string | null;
  tokenExpiresAt: Date | null;
  /** Present when the demo came from the public form. */
  requestId: string | null;
  requesterWhatsapp: string | null;
}

export function ageInDays(createdAt: Date, now: Date = new Date()): number {
  return Math.max(0, Math.floor((now.getTime() - createdAt.getTime()) / 86_400_000));
}

/**
 * The pack a demo was built from IS stored on the tenant since the 2026-08-20 pre-launch
 * migration — `Tenant.demoPackKey`, the honest fix `docs/decisions/b3.md` asked for, written by
 * `createDemo` in the main session. Demos created BEFORE the column existed have it null, so the
 * list still falls back to the originating `DemoRequest` while one survives (they are deleted on
 * day 30) and reports the template beside it either way.
 */
function templateName(templateKey: string): string {
  return isTemplateKey(templateKey) ? TEMPLATES[templateKey].name : templateKey;
}

export async function listDemos(actor: Actor, now: Date = new Date()): Promise<DemoListRow[]> {
  const db = superAdminDb(actor);

  const tenants = await db.tenant.findMany({
    where: { isDemo: true },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      name: true,
      slug: true,
      createdAt: true,
      demoPackKey: true,
      site: { select: { templateKey: true } },
      _count: { select: { products: true } },
      demoLinks: {
        where: { revokedAt: null },
        orderBy: { createdAt: 'desc' },
        select: { token: true, expiresAt: true },
      },
    },
  });

  // One read for every originating request, rather than one per demo.
  const requests = await db.demoRequest.findMany({
    where: { createdTenantId: { in: tenants.map((tenant) => tenant.id) } },
    select: { id: true, createdTenantId: true, packKey: true, whatsapp: true },
  });
  const requestByTenant = new Map(
    requests.filter((row) => row.createdTenantId).map((row) => [row.createdTenantId!, row]),
  );

  return tenants.map((tenant) => {
    const live = tenant.demoLinks.find(
      (link) => link.expiresAt === null || link.expiresAt.getTime() > now.getTime(),
    );
    const request = requestByTenant.get(tenant.id);

    return {
      tenantId: tenant.id,
      name: tenant.name,
      slug: tenant.slug,
      createdAt: tenant.createdAt,
      ageDays: ageInDays(tenant.createdAt, now),
      templateName: templateName(tenant.site?.templateKey ?? ''),
      // The durable column first; the request only covers pre-column demos until day 30.
      packKey:
        (tenant.demoPackKey as PackKey | null) ??
        (request?.packKey as PackKey | undefined) ??
        null,
      productCount: tenant._count.products,
      demoUrl: live ? demoStorefrontUrl(tenant.slug, live.token) : null,
      tokenExpiresAt: live?.expiresAt ?? null,
      requestId: request?.id ?? null,
      /**
       * FROM THE REQUEST ONLY, AND IT DISAPPEARS ON DAY 30 — which is the promise being kept, not
       * a bug.
       *
       * B1's nightly sweep deletes a `DemoRequest` once `purgeAfter` passes, approved or not,
       * because that is what the public form's Arabic notice says will happen. So this column
       * empties roughly when the age column starts flagging the demo as forgotten, and an operator
       * looking at a 40-day-old demo has no prospect file to work from. The answer available to
       * them is the one on the screen: close it.
       *
       * `Site.whatsapp` still holds that number — it has to, or the demo's own WhatsApp button
       * would not work — but it is the SHOP's contact detail, not a prospect record, and reading it
       * here would quietly reconstruct the file the sweep just deleted.
       */
      requesterWhatsapp: request?.whatsapp ?? null,
    };
  });
}

export interface DemoDetail extends DemoListRow {
  categoryCount: number;
  sectionCount: number;
  testimonialCount: number;
  /** Images still waiting on the variant pipeline — the "is it ready to send?" signal. */
  mediaPending: number;
  mediaReady: number;
}

export async function getDemo(
  actor: Actor,
  tenantId: string,
  now: Date = new Date(),
): Promise<DemoDetail | null> {
  const rows = await listDemos(actor, now);
  const row = rows.find((demo) => demo.tenantId === tenantId);
  if (!row) return null;

  const db = superAdminDb(actor);
  const [categoryCount, sectionCount, testimonialCount, mediaPending, mediaReady] =
    await Promise.all([
      db.category.count({ where: { tenantId } }),
      // The home arrangement, not the legal pages Phase 6 generates beside it — the number on
      // this screen answers "is the demo built", and forty policy clauses would drown it.
      db.section.count({ where: { tenantId, page: { slug: HOME_PAGE_SLUG } } }),
      db.testimonial.count({ where: { tenantId } }),
      db.media.count({ where: { tenantId, status: { in: ['pending', 'processing'] } } }),
      db.media.count({ where: { tenantId, status: 'ready' } }),
    ]);

  return { ...row, categoryCount, sectionCount, testimonialCount, mediaPending, mediaReady };
}

/**
 * Set or clear a per-demo expiry on the live magic link.
 *
 * The default is no expiry (Q2 — a demo that dies on a timer dies mid-sales-call), and this is the
 * "optional expiry may be set per demo" half of it. It touches `DemoLink` only: nothing about the
 * subscription changes, which is what keeps it out of `src/server/billing`.
 */
export async function setDemoLinkExpiry(
  actor: Actor,
  tenantId: string,
  expiresAt: Date | null,
): Promise<number> {
  const { count } = await superAdminDb(actor).demoLink.updateMany({
    where: { tenantId, revokedAt: null },
    data: { expiresAt },
  });

  return count;
}
