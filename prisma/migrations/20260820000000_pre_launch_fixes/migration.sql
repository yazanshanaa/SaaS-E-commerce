-- Pre-launch fixes (2026-08-20). Additive only, written in the main session (CLAUDE.md's schema
-- rule). Two changes, both carried forward on TODO.md's own list since Phase 5/B3.

-- 1. Tenant.demoPackKey — WHICH pack built a demo, durable on the tenant itself.
--    The originating DemoRequest also carries the pack, but that row is deleted on day 30 (the
--    public form's own Arabic promise, kept by the nightly sweep) and never existed at all for an
--    admin-created demo — so the demos list reported the TEMPLATE and called it the pack.
--    Null on every real account and on demos created before this column existed; the list falls
--    back to the request while one survives.
ALTER TABLE "tenants" ADD COLUMN "demo_pack_key" TEXT;

-- 2. At most ONE ENABLED gateway per tenant — the database backstop for the application rule in
--    src/server/payments (the Phase 5 carry-forward: "a partial unique index would be the belt,
--    and it would be a migration"). A partial index is outside Prisma's schema language, so it
--    lives here by hand, exactly like migration 0001's RLS blocks; the GatewayConfig model
--    carries a /// comment pointing back at it.
--    `WHERE "enabled"` means any number of DISABLED configs per tenant (credentials parked for
--    later) and never two live ones — the state the checkout resolver already assumes is
--    unrepresentable.
CREATE UNIQUE INDEX "gateway_configs_one_enabled_per_tenant"
  ON "gateway_configs" ("tenant_id")
  WHERE "enabled";
