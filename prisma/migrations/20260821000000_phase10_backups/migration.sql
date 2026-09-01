-- Phase 10 — per-tenant backups and the standalone bundle (Q24, Q25, Q26).
-- Additive, main session, one migration. Two enums and one tenant-owned table; nothing global is
-- added, so prisma/GLOBAL_TABLES.md is unchanged.

-- CreateEnum
CREATE TYPE "tenant_backup_kind" AS ENUM ('backup', 'standalone_export');

-- CreateEnum
CREATE TYPE "tenant_backup_status" AS ENUM ('pending', 'ready', 'failed', 'restoring');

-- CreateTable
CREATE TABLE "tenant_backups" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "kind" "tenant_backup_kind" NOT NULL DEFAULT 'backup',
    "status" "tenant_backup_status" NOT NULL DEFAULT 'pending',
    "key" TEXT,
    "size_bytes" INTEGER,
    "schema_version" TEXT NOT NULL,
    "app_commit" TEXT,
    "contents" JSONB,
    "note" TEXT,
    "error" TEXT,
    "created_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "tenant_backups_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "tenant_backups_tenant_id_created_at_idx" ON "tenant_backups"("tenant_id", "created_at");

-- CreateIndex
CREATE INDEX "tenant_backups_tenant_id_status_idx" ON "tenant_backups"("tenant_id", "status");

-- AddForeignKey
ALTER TABLE "tenant_backups" ADD CONSTRAINT "tenant_backups_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- =============================================================================
-- Hand-written from here on — nothing below this line came from `prisma migrate diff`.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Row-level security — the generic template from
--    prisma/migrations/20260809000100_rls_roles_and_guards/migration.sql, scoped to the one new
--    tenant-owned table, exactly as Phase 8 and Phase 9 did.
--
--    A backup row is tenant-owned even though only a super admin ever sees one. That is not a
--    contradiction: the super-admin branch of the policy is what grants the operator access, and
--    tenant ownership is what makes the CASCADE destroy these rows when the tenant is purged. A
--    global table would have left a merchant's backup inventory alive after the deletion the
--    platform promised them.
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  t text;
  tenant_tables text[] := ARRAY['tenant_backups'];
BEGIN
  FOREACH t IN ARRAY tenant_tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);

    EXECUTE format($p$
      CREATE POLICY tenant_isolation ON %I
        FOR ALL TO app_web
        USING (
          tenant_id = current_setting('app.tenant_id', true)
          OR current_setting('app.actor_role', true) = 'super_admin'
        )
        WITH CHECK (
          tenant_id = current_setting('app.tenant_id', true)
          OR current_setting('app.actor_role', true) = 'super_admin'
        )
    $p$, t);

    EXECUTE format($p$
      CREATE POLICY system_read ON %I FOR SELECT TO app_system USING (true)
    $p$, t);

    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO app_web', t);
    EXECUTE format('GRANT SELECT ON %I TO app_system', t);
  END LOOP;
END
$$;

-- -----------------------------------------------------------------------------
-- 2. Database-level guards that do not depend on application code being correct.
-- -----------------------------------------------------------------------------

-- A ready backup HAS an artifact; a pending one does not yet. Without this, a failed build that
-- stamped `ready` without a key would render in the admin list as a downloadable row whose
-- download 404s — the operator learns their backup does not exist at the moment they need it.
ALTER TABLE "tenant_backups" ADD CONSTRAINT "tenant_backups_ready_has_key" CHECK (
  "status" <> 'ready' OR ("key" IS NOT NULL AND "size_bytes" IS NOT NULL)
);

-- Sizes are bytes, and bytes are not negative — the same rule migration 0001 applies to money.
ALTER TABLE "tenant_backups" ADD CONSTRAINT "tenant_backups_size_nonneg" CHECK (
  "size_bytes" IS NULL OR "size_bytes" >= 0
);

-- Every artifact lives under the tenant's own prefix, which is what makes the purge's
-- `deleteByPrefix(tenants/{id}/)` sweep it by construction (src/server/storage/types.ts). A row
-- pointing anywhere else would be an artifact the deletion promise does not cover, so the shape is
-- refused by the database rather than trusted to the one code path that writes it.
ALTER TABLE "tenant_backups" ADD CONSTRAINT "tenant_backups_key_under_tenant_prefix" CHECK (
  "key" IS NULL OR "key" LIKE 'tenants/' || "tenant_id" || '/_backups/%'
);
