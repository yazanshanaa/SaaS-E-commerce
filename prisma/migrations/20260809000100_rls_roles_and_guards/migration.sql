-- =============================================================================
-- Souq Bartaa — isolation, roles and database-level guards.
--
-- Migration 0000 created the tables. This one makes them safe.
--
-- Invariant 1: tenant isolation is enforced TWICE — once by the Prisma client extension
-- (which sets the GUCs) and once by row-level security here. The second layer is the one
-- that matters: if the extension is bypassed, forgotten, or a raw query slips through,
-- Postgres still refuses to return another tenant's rows. tests/integration/isolation.test.ts
-- proves exactly that by running with the extension disabled.
--
-- Three GUCs, all set with set_config(..., true) so they are transaction-local:
--   app.tenant_id   — the tenant this transaction may touch
--   app.user_id     — the authenticated user, for the `members` self policy
--   app.actor_role  — 'super_admin' | 'owner' | 'staff' | 'system' | 'public'
--                     set SERVER-SIDE ONLY, after a verified session. A client cannot
--                     influence it; nothing reads it from a header, a cookie or a body.
--
-- The `OR app.actor_role = 'super_admin'` clause is the ONLY legitimate cross-tenant read
-- path over HTTP. An HTTP request never runs as app_system.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Roles. No BYPASSRLS anywhere, ever.
--
-- Created NOLOGIN here so a fresh database migrates cleanly; the deployment gives them
-- LOGIN and a password (docs/BUILD-KIT.md Part 6). If they already exist — the dev compose
-- and the test harness create them as superuser — this block is a no-op and needs no
-- privilege of its own.
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_web') THEN
    CREATE ROLE app_web NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_system') THEN
    CREATE ROLE app_system NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_migrate') THEN
    CREATE ROLE app_migrate NOLOGIN;
  END IF;
END
$$;

-- Guard: a role with BYPASSRLS would make every policy below decorative.
DO $$
DECLARE offending text;
BEGIN
  SELECT string_agg(rolname, ', ') INTO offending
  FROM pg_roles
  WHERE rolname IN ('app_web', 'app_system', 'app_migrate') AND rolbypassrls;

  IF offending IS NOT NULL THEN
    RAISE EXCEPTION 'BYPASSRLS is set on: % — row-level security would be decorative. Remove it.', offending;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO app_web, app_system;

-- -----------------------------------------------------------------------------
-- 2. Database-level guards that do not depend on application code being correct.
-- -----------------------------------------------------------------------------

-- A DemoRequest that never becomes a demo disappears on its own (Q6 / B3's Arabic notice).
ALTER TABLE "demo_requests"
  ALTER COLUMN "purge_after" SET DEFAULT (now() + interval '30 days');

-- better-auth writes membership roles as plain strings; the domain has exactly two (Q13).
ALTER TABLE "members"
  ADD CONSTRAINT "members_role_check" CHECK ("role" IN ('owner', 'staff'));
ALTER TABLE "invitations"
  ADD CONSTRAINT "invitations_role_check" CHECK ("role" IN ('owner', 'staff'));

ALTER TABLE "theme_settings"
  ADD CONSTRAINT "theme_settings_color_mode_check" CHECK ("color_mode" IN ('preset', 'custom'));

-- Money is agorot, and agorot are not negative.
ALTER TABLE "products" ADD CONSTRAINT "products_price_nonneg" CHECK ("price_agorot" >= 0);
ALTER TABLE "payments" ADD CONSTRAINT "payments_amount_nonneg" CHECK ("amount_agorot" >= 0);
ALTER TABLE "plans" ADD CONSTRAINT "plans_prices_nonneg"
  CHECK ("price_monthly_agorot" >= 0 AND "price_yearly_agorot" >= 0 AND "setup_fee_agorot" >= 0);
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_quantity_positive" CHECK ("quantity" > 0);

-- Suspension coherence. Two failures this prevents outright:
--   * an ACTIVE subscription carrying a stale retention_until — one filter bug away from
--     purging a paying merchant,
--   * a SUSPENDED subscription with no suspended_at — invisible to every lifecycle screen.
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_suspension_coherent" CHECK (
  ("status" = 'suspended' AND "suspended_at" IS NOT NULL)
  OR ("status" = 'active' AND "suspended_at" IS NULL AND "retention_until" IS NULL)
);

-- A NULL current_period_end is legal ONLY on the hidden demo plan. Without this, a real
-- paying account with a null period end is silently never swept, never reminded, never
-- suspended and never purged — a hole no admin screen would ever show.
-- A CHECK constraint cannot reach another table, so this is a trigger; the billing service
-- carries the same rule and tests cover both.
CREATE OR REPLACE FUNCTION "enforce_period_end_only_null_on_demo_plan"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_hidden boolean;
BEGIN
  IF NEW."current_period_end" IS NULL THEN
    SELECT "hidden" INTO v_hidden FROM "plans" WHERE "id" = NEW."plan_id";

    IF v_hidden IS DISTINCT FROM TRUE THEN
      RAISE EXCEPTION
        'subscriptions.current_period_end may be NULL only on the hidden demo plan (plan_id=%)',
        NEW."plan_id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "subscriptions_period_end_guard"
  BEFORE INSERT OR UPDATE OF "current_period_end", "plan_id" ON "subscriptions"
  FOR EACH ROW
  EXECUTE FUNCTION "enforce_period_end_only_null_on_demo_plan"();

-- -----------------------------------------------------------------------------
-- 3. Row-level security on every tenant-owned table.
--
-- FORCE is not optional: without it the table owner (app_migrate) silently bypasses every
-- policy, and the seed would be "proof" that isolation works while proving nothing.
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  t text;
  tenant_tables text[] := ARRAY[
    'members',
    'invitations',
    'subscriptions',
    'subscription_reminders',
    'entitlements',
    'capability_overrides',
    'sites',
    'theme_settings',
    'social_links',
    'pages',
    'sections',
    'announcements',
    'testimonials',
    'categories',
    'products',
    'product_images',
    'media',
    'media_variants',
    'domains',
    'demo_links',
    'payments',
    'gateway_configs',
    'change_requests',
    'consents',
    'push_subscriptions',
    'push_messages',
    'orders',
    'order_items',
    'tenant_counters',
    'notifications',
    'events',
    'audit_logs'
  ];
BEGIN
  FOREACH t IN ARRAY tenant_tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);

    -- The generic template. Identical USING and WITH CHECK: a tenant may not read another
    -- tenant's row, and may not write one either.
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

    -- app_system reads ids to fan out. It never writes a tenant-owned table — enforced by
    -- the GRANTs below, not merely by this policy.
    EXECUTE format($p$
      CREATE POLICY system_read ON %I FOR SELECT TO app_system USING (true)
    $p$, t);

    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO app_web', t);
    EXECUTE format('GRANT SELECT ON %I TO app_system', t);
  END LOOP;
END
$$;

-- The isolation root itself: same rule, keyed on its own primary key.
ALTER TABLE "tenants" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tenants" FORCE ROW LEVEL SECURITY;

CREATE POLICY "tenant_isolation" ON "tenants"
  FOR ALL TO app_web
  USING (
    "id" = current_setting('app.tenant_id', true)
    OR current_setting('app.actor_role', true) = 'super_admin'
  )
  WITH CHECK (
    "id" = current_setting('app.tenant_id', true)
    OR current_setting('app.actor_role', true) = 'super_admin'
  );

CREATE POLICY "system_read" ON "tenants" FOR SELECT TO app_system USING (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON "tenants" TO app_web;
GRANT SELECT ON "tenants" TO app_system;

-- -----------------------------------------------------------------------------
-- 4. Narrow named policies for the work that happens BEFORE a tenant context exists.
--
-- Each one is scoped by "no tenant context is set yet", so it cannot double as a
-- cross-tenant read once a request has been resolved. That single condition is what keeps
-- hostname resolution possible without making every tenant's domains visible to every
-- other tenant.
-- -----------------------------------------------------------------------------

-- proxy.ts resolves hostname -> tenant before anything is known. A hostname is public
-- information (it is in DNS); the rest of the row is not, and becomes invisible the moment
-- a tenant context exists.
CREATE POLICY "domain_hostname_lookup" ON "domains"
  FOR SELECT TO app_web
  USING (coalesce(current_setting('app.tenant_id', true), '') = '');

-- The other half of hostname resolution: `{slug}.{DOMAIN}` resolves against this table, and
-- a custom domain still has to read the tenant it points at. Everything this exposes is
-- already public — the slug is in the URL, the name is on the page, `is_demo` is stamped on
-- the storefront as a watermark, and `state` is visible as an open or closed site.
--
-- Note what this does NOT do: read the subscription. A pre-context policy there would expose
-- `export_download_token`, a bearer credential to a merchant's whole catalogue, to any
-- unauthenticated request. `tenants.state` exists precisely so this lookup never has to.
CREATE POLICY "tenant_hostname_lookup" ON "tenants"
  FOR SELECT TO app_web
  USING (coalesce(current_setting('app.tenant_id', true), '') = '');

-- Q8's magic link: resolvable pre-context, and only while it is actually live.
CREATE POLICY "demo_link_live_token_lookup" ON "demo_links"
  FOR SELECT TO app_web
  USING (
    coalesce(current_setting('app.tenant_id', true), '') = ''
    AND "revoked_at" IS NULL
    AND ("expires_at" IS NULL OR "expires_at" > now())
  );

-- A user must be able to discover which tenants they belong to before choosing one.
-- Own rows only — never anyone else's membership.
CREATE POLICY "member_self" ON "members"
  FOR SELECT TO app_web
  USING ("user_id" = current_setting('app.user_id', true));

-- The Q18 export download arrives with no session at all: a suspended merchant opening a
-- WhatsApp link. Resolving the token needs exactly one row, and only while the token is
-- live and the retention window is open. Everything after that (audit row, download stamp,
-- signed URL) happens inside a tenant context.
CREATE POLICY "subscription_export_token_lookup" ON "subscriptions"
  FOR SELECT TO app_web
  USING (
    coalesce(current_setting('app.tenant_id', true), '') = ''
    AND "export_download_token" IS NOT NULL
    AND "status" = 'suspended'
    AND "retention_until" IS NOT NULL
    AND "retention_until" > now()
  );

-- -----------------------------------------------------------------------------
-- 5. Global tables.
--
-- "Global" means "not tenant-owned", never "unpoliced". The three that hold personal data
-- get explicit policies; the generic template cannot apply to them because they have no
-- tenant_id column at all.
-- -----------------------------------------------------------------------------

GRANT SELECT ON "plans", "plan_features", "plan_capabilities", "templates" TO app_web, app_system;
GRANT INSERT, UPDATE, DELETE ON "plans", "plan_features", "plan_capabilities", "templates" TO app_web;

-- --- Identity ---------------------------------------------------------------
-- The auth tables answer to their OWN context flag rather than to "no tenant is set".
-- If they keyed on a missing tenant context, every code path that merely forgot to scope
-- itself would be able to read session tokens. src/server/auth is the only place that sets
-- app.auth_context, and a guardrail test enforces that.
ALTER TABLE "sessions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sessions" FORCE ROW LEVEL SECURITY;
ALTER TABLE "accounts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "accounts" FORCE ROW LEVEL SECURITY;
ALTER TABLE "verifications" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "verifications" FORCE ROW LEVEL SECURITY;
ALTER TABLE "two_factors" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "two_factors" FORCE ROW LEVEL SECURITY;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['sessions', 'accounts', 'verifications', 'two_factors'] LOOP
    EXECUTE format($p$
      CREATE POLICY auth_internal ON %I
        FOR ALL TO app_web
        USING (current_setting('app.auth_context', true) = 'on')
        WITH CHECK (current_setting('app.auth_context', true) = 'on')
    $p$, t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO app_web', t);
  END LOOP;
END
$$;

-- Users are visible to the auth layer, to themselves, to a super admin, and to the tenant
-- they are a member of (so B2's staff list works) — and to nobody else.
ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "users" FORCE ROW LEVEL SECURITY;

CREATE POLICY "user_access" ON "users"
  FOR ALL TO app_web
  USING (
    current_setting('app.auth_context', true) = 'on'
    OR current_setting('app.actor_role', true) = 'super_admin'
    OR "id" = current_setting('app.user_id', true)
    OR EXISTS (
      SELECT 1 FROM "members" m
      WHERE m."user_id" = "users"."id"
        AND m."tenant_id" = current_setting('app.tenant_id', true)
    )
  )
  WITH CHECK (
    current_setting('app.auth_context', true) = 'on'
    OR current_setting('app.actor_role', true) = 'super_admin'
    OR "id" = current_setting('app.user_id', true)
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON "users" TO app_web;
GRANT SELECT ON "users" TO app_system;

-- --- DemoRequest: a prospect's phone number and address, before any tenant exists --------
-- INSERT ONLY for app_web (B3's public form) with NO select. Leaving it unpoliced would
-- expose every prospect to every merchant connection.
ALTER TABLE "demo_requests" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "demo_requests" FORCE ROW LEVEL SECURITY;

CREATE POLICY "demo_request_public_insert" ON "demo_requests"
  FOR INSERT TO app_web
  WITH CHECK (true);

CREATE POLICY "demo_request_admin_select" ON "demo_requests"
  FOR SELECT TO app_web
  USING (current_setting('app.actor_role', true) = 'super_admin');

CREATE POLICY "demo_request_admin_update" ON "demo_requests"
  FOR UPDATE TO app_web
  USING (current_setting('app.actor_role', true) = 'super_admin')
  WITH CHECK (current_setting('app.actor_role', true) = 'super_admin');

-- The daily sweep deletes rows past purge_after; it runs as app_system, never as app_web.
CREATE POLICY "demo_request_system_sweep" ON "demo_requests"
  FOR ALL TO app_system
  USING (true)
  WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE ON "demo_requests" TO app_web;
GRANT SELECT, DELETE ON "demo_requests" TO app_system;

-- --- TenantTombstone: what survives the purge -------------------------------------------
ALTER TABLE "tenant_tombstones" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tenant_tombstones" FORCE ROW LEVEL SECURITY;

-- The purge job writes its own tenant's tombstone from inside withTenantTxn.
CREATE POLICY "tombstone_write" ON "tenant_tombstones"
  FOR INSERT TO app_web
  WITH CHECK (
    "tenant_id" = current_setting('app.tenant_id', true)
    OR current_setting('app.actor_role', true) = 'super_admin'
  );

-- Merchants never read tombstones — not even their own; by the time one exists there is no
-- merchant left to read it.
CREATE POLICY "tombstone_admin_read" ON "tenant_tombstones"
  FOR SELECT TO app_web
  USING (current_setting('app.actor_role', true) = 'super_admin');

CREATE POLICY "tombstone_system_read" ON "tenant_tombstones"
  FOR SELECT TO app_system
  USING (true);

GRANT SELECT, INSERT ON "tenant_tombstones" TO app_web;
GRANT SELECT ON "tenant_tombstones" TO app_system;

-- --- DsrRequest: global so a purge cannot destroy the proof we honoured it ----------------
ALTER TABLE "dsr_requests" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "dsr_requests" FORCE ROW LEVEL SECURITY;

CREATE POLICY "dsr_public_insert" ON "dsr_requests"
  FOR INSERT TO app_web
  WITH CHECK (true);

CREATE POLICY "dsr_admin_read" ON "dsr_requests"
  FOR SELECT TO app_web
  USING (current_setting('app.actor_role', true) = 'super_admin');

CREATE POLICY "dsr_admin_update" ON "dsr_requests"
  FOR UPDATE TO app_web
  USING (current_setting('app.actor_role', true) = 'super_admin')
  WITH CHECK (current_setting('app.actor_role', true) = 'super_admin');

GRANT SELECT, INSERT, UPDATE ON "dsr_requests" TO app_web;

-- --- Platform audit: the "global side" of audit_logs -------------------------------------
ALTER TABLE "platform_audit_logs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "platform_audit_logs" FORCE ROW LEVEL SECURITY;

CREATE POLICY "platform_audit_write" ON "platform_audit_logs"
  FOR INSERT TO app_web
  WITH CHECK (current_setting('app.actor_role', true) IN ('super_admin', 'system'));

CREATE POLICY "platform_audit_read" ON "platform_audit_logs"
  FOR SELECT TO app_web
  USING (current_setting('app.actor_role', true) = 'super_admin');

CREATE POLICY "platform_audit_system" ON "platform_audit_logs"
  FOR ALL TO app_system
  USING (true)
  WITH CHECK (true);

GRANT SELECT, INSERT ON "platform_audit_logs" TO app_web;
GRANT SELECT, INSERT ON "platform_audit_logs" TO app_system;

-- --- Outbound webhooks -------------------------------------------------------------------
-- Deliveries are materialised at emit time and must OUTLIVE the tenant: the `purged` event
-- is emitted moments before the cascade removes every tenant-owned row, including the Event
-- that produced it.
ALTER TABLE "webhook_endpoints" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "webhook_endpoints" FORCE ROW LEVEL SECURITY;
ALTER TABLE "webhook_deliveries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "webhook_deliveries" FORCE ROW LEVEL SECURITY;

-- Emitting an event materialises its deliveries in the SAME transaction, from whatever
-- context emitted it — including a merchant action. So any server context must be able to
-- see which endpoints exist. It must NOT be able to see their signing secrets: that HMAC key
-- authenticates messages to n8n, which acts on tenant data.
--
-- RLS is row-level, so the restriction is a COLUMN grant. `secret` is granted to app_system
-- (the dispatcher, which signs) and to nobody else — a super admin may rotate it by writing,
-- never by reading. Consequence for the application: every query against this table must
-- name its columns explicitly, because a bare SELECT * is refused.
CREATE POLICY "webhook_endpoint_read" ON "webhook_endpoints"
  FOR SELECT TO app_web
  USING (true);

CREATE POLICY "webhook_endpoint_admin_insert" ON "webhook_endpoints"
  FOR INSERT TO app_web
  WITH CHECK (current_setting('app.actor_role', true) = 'super_admin');

CREATE POLICY "webhook_endpoint_admin_update" ON "webhook_endpoints"
  FOR UPDATE TO app_web
  USING (current_setting('app.actor_role', true) = 'super_admin')
  WITH CHECK (current_setting('app.actor_role', true) = 'super_admin');

CREATE POLICY "webhook_endpoint_admin_delete" ON "webhook_endpoints"
  FOR DELETE TO app_web
  USING (current_setting('app.actor_role', true) = 'super_admin');

CREATE POLICY "webhook_endpoint_system" ON "webhook_endpoints"
  FOR ALL TO app_system
  USING (true)
  WITH CHECK (true);

-- Any server context may enqueue a delivery (that is what emitting an event does); only the
-- dispatcher, running as app_system, may read or update the queue.
CREATE POLICY "webhook_delivery_enqueue" ON "webhook_deliveries"
  FOR INSERT TO app_web
  WITH CHECK (coalesce(current_setting('app.actor_role', true), '') <> '');

CREATE POLICY "webhook_delivery_admin_read" ON "webhook_deliveries"
  FOR SELECT TO app_web
  USING (current_setting('app.actor_role', true) = 'super_admin');

CREATE POLICY "webhook_delivery_system" ON "webhook_deliveries"
  FOR ALL TO app_system
  USING (true)
  WITH CHECK (true);

GRANT SELECT ("id", "name", "url", "active", "event_types", "created_at", "updated_at")
  ON "webhook_endpoints" TO app_web;
GRANT INSERT, UPDATE, DELETE ON "webhook_endpoints" TO app_web;
GRANT SELECT, INSERT ON "webhook_deliveries" TO app_web;
GRANT SELECT, INSERT, UPDATE, DELETE ON "webhook_endpoints", "webhook_deliveries" TO app_system;

-- Sequences: cuid ids mean there are none today, but a later ALTER must not silently break
-- app_web, and granting on an empty set is free.
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_web, app_system;
