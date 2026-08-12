-- Phase 6 — compliance and security hardening.
--
-- Four changes, each of which exists because a Phase 6 requirement could not be met without it.
-- Nothing here touches a tenant-owned table's shape except to REMOVE a column that was never
-- written, so no backfill is needed and no running query changes meaning.

-- 1. A storefront CUSTOMER is a data subject in its own right ------------------------------
--
-- Phase 5 made orders persist, so the platform now holds a real name and a real phone number
-- belonging to someone who has no account and never will. Decision (c) requires the DSR box to
-- cover them, and filing them under `visitor` would have merged two classes with nothing in
-- common: a visitor is a monthly rotating hash, a customer is a name on an Order row.
ALTER TYPE "dsr_subject_kind" ADD VALUE IF NOT EXISTS 'customer' AFTER 'visitor';

-- 2. Drop `consents.ip_hash` ---------------------------------------------------------------
--
-- Never written by any code path since Phase 1, and deliberately so: an IP HMAC with no tenant
-- salt and no time salt is byte-identical for the same visitor across every tenant, and joinable
-- against `demo_requests.ip_hash` — the exact cross-tenant link `visitor_hash` was designed to
-- prevent (the reasoning is at src/app/api/storefront/consent/route.ts).
--
-- Kept as a documented-but-empty column, it was a standing invitation for a later phase to "fix"
-- the gap by filling it. Removing it makes the decision permanent, and it makes the privacy copy
-- simpler to keep true: there is no IP field on a consent record, rather than one that happens to
-- be null.
ALTER TABLE "consents" DROP COLUMN IF EXISTS "ip_hash";

-- 3. A retention sweep needs somewhere to delete from ---------------------------------------
--
-- Three global tables outlive every tenant by design, and until now nothing could remove a row
-- from any of them — `tenant_tombstones` and `platform_audit_logs` granted app_system SELECT
-- only, and `dsr_requests` had no app_system grant at all. "Forever" is not a retention policy
-- (prisma/GLOBAL_TABLES.md defers the number to this phase), and a policy nothing can enforce is
-- not a policy either.
--
-- The DELETE right is given to app_system ONLY. These rows are the record that a deletion
-- happened; an HTTP request must never be able to erase its own audit trail, and app_web is the
-- role every HTTP request runs as.

CREATE POLICY "tombstone_system_delete" ON "tenant_tombstones"
  FOR DELETE TO app_system
  USING (true);

GRANT DELETE ON "tenant_tombstones" TO app_system;

CREATE POLICY "platform_audit_system_delete" ON "platform_audit_logs"
  FOR DELETE TO app_system
  USING (true);

GRANT DELETE ON "platform_audit_logs" TO app_system;

-- `dsr_requests` had no system-role policy at all, so the sweep needs both halves.
CREATE POLICY "dsr_system_read" ON "dsr_requests"
  FOR SELECT TO app_system
  USING (true);

CREATE POLICY "dsr_system_delete" ON "dsr_requests"
  FOR DELETE TO app_system
  USING (true);

GRANT SELECT, DELETE ON "dsr_requests" TO app_system;

-- 4. The one lookup a data-subject request actually makes ------------------------------------
--
-- A demo prospect has no account and no email on file; they are found by phone hash. That was a
-- sequential scan, on the screen an operator opens while someone waits on the phone.
CREATE INDEX IF NOT EXISTS "dsr_requests_subject_phone_hash_idx"
  ON "dsr_requests"("subject_phone_hash");

-- 5. The index the retention sweep actually filters on -------------------------------------
--
-- `webhook_deliveries` gains a row per event per endpoint and, until this phase, never lost one.
-- The nightly prune selects terminal rows older than a cutoff, which without this index is a
-- sequential scan over the largest table on the platform.
CREATE INDEX IF NOT EXISTS "webhook_deliveries_status_created_at_idx"
  ON "webhook_deliveries"("status", "created_at");
