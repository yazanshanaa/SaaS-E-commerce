# Global tables — the whitelist

Invariant 1: **every tenant-owned table carries `tenantId`** and is policed by the generic RLS
template in `prisma/migrations/20260809000100_rls_roles_and_guards/migration.sql`.

A table that is *not* tenant-owned must appear in this file with a one-line justification.
A new global table without a line here is a review failure — and Phase 6's manual isolation
review checks exactly this list.

**"Global" never means "unpoliced."** Three of these tables hold personal data and have no
`tenant_id` column for the generic template to key on; each one gets a named policy instead.

---

## Identity (better-auth)

| Table | Why it is global | Policy |
|---|---|---|
| `users` | A person is not owned by a merchant. A super admin belongs to no tenant, and a user could in principle belong to two. | RLS on: the auth layer's own context flag, self, super admin, or a member of the current tenant. |
| `sessions` | A session belongs to a user, and is resolved before any tenant is known. | RLS on: `app.auth_context = 'on'` only. Keyed on the auth flag rather than on "no tenant context" so that a code path which merely *forgot* to scope itself still cannot read session tokens. |
| `accounts` | Credentials belong to a user. Holds the argon2 hash. | Same as `sessions`. |
| `verifications` | Email-verification and password-reset tokens are issued before a tenant context exists. | Same as `sessions`. |
| `two_factors` | 2FA secrets belong to a user, not a merchant. | Same as `sessions`. |

`members` and `invitations` are **not** here: they are tenant-owned, carry `tenantId`, and are
fully policed. The `member` table is the single membership source (docs/PHASES.md item 3), with
one extra narrow policy — `member_self` — so a user can discover which tenants they belong to
before choosing one.

## Catalogue of what may be sold

| Table | Why it is global | Policy |
|---|---|---|
| `plans` | A plan is the platform's product, offered to every tenant. Per-tenant deviation is an `Entitlement` / `CapabilityOverride` row, which *is* tenant-owned. | Readable by everyone (a plan is public); writable by super admin only. |
| `plan_features` | Axis (a) defaults, per plan. | As `plans`. |
| `plan_capabilities` | Axis (b) defaults, per plan. | As `plans`. |
| `templates` | The three launch templates are platform assets. `templates_allowed` names them; it does not own them. | As `plans`. |

## Tables that must OUTLIVE the tenant

This is the load-bearing group. Each one exists because a purge cascade-deletes everything
tenant-owned — including the records that prove the purge was done correctly.

| Table | Why it is global |
|---|---|
| `tenant_tombstones` | The purge deletes the `Tenant` row and the cascade takes its `AuditLog` rows and its `Event`s with it. The tombstone is what survives. Deliberately minimal: it records **that** an export was delivered and whether it was ever downloaded — facts, and the platform's defence if a merchant complains — but never *where* it was, and it stores a **hash** of the slug rather than the slug and the trading name. A small merchant's trading name is usually a person's name; keeping it forever would contradict the very deletion the row exists to prove. The hash still answers "was this slug ever used", which is the only operational need. |
| `dsr_requests` | If it cascaded with the tenant, purging would destroy the record proving we honoured a data-subject request — the same trap the tombstone exists to avoid, one table over. Note the second reason: a data subject may have **no tenant at all** (a demo prospect who only ever filled in the public form). |
| `platform_audit_logs` | The "global side" of the audit trail. Two kinds of action land here: those with no tenant to hang on (plan CRUD, demo-request decisions) and those whose whole point is to survive the tenant (closing a demo, purging one). `audit_logs` stays tenant-owned for everything else, so a merchant's audit trail dies with their data as promised. |
| `webhook_deliveries` | Deliveries are materialised at emit time and must outlive the tenant: `purged` is emitted moments before the cascade removes every tenant-owned row, including the `Event` that produced it. If deliveries cascaded too, the one event the platform most needs to deliver would be the one event it could never send. `tenantRef` is a plain column, not a foreign key, precisely so the delivery survives. |

### Retention — added in Phase 6

"Global" used to mean "forever" for the four tables above, and a privacy policy that discloses a
surviving record without a ceiling has disclosed a permanent one. Each now ends:

| Table | Window | Enforced by |
|---|---|---|
| `tenant_tombstones` | `TOMBSTONE_RETENTION_DAYS` (730) | `prune-records`, daily at 04:00 Asia/Jerusalem |
| `platform_audit_logs` | `TOMBSTONE_RETENTION_DAYS` (730) | same job — it is the operator-side half of the same record |
| `dsr_requests` | `TOMBSTONE_RETENTION_DAYS` from `completedAt`, and only once CLOSED | same job. An unanswered request is the last row that should age out, so an open one is never swept |
| `webhook_deliveries` | `WEBHOOK_DELIVERY_RETENTION_DAYS` (30), terminal rows only | same job. `pending` and `failed` are live state the dispatcher will retry |

DELETE on all four is granted to **`app_system` alone**. An HTTP request runs as `app_web` and
therefore cannot erase its own audit trail — which is why `tenant_tombstones` is the one table with
a `tenant_id` column that `app_system` may write, and why `rls-coverage.test.ts` now defines
"tenant-owned" by the presence of a foreign key to `tenants` rather than by the column name.

## Platform-wide constants — added in Phase 8

| Table | Why it is global | Policy |
|---|---|---|
| `platform_settings` | A SINGLETON (the `platform_settings_is_singleton` CHECK makes any id other than `'singleton'` unrepresentable): one platform-wide constant — currently `order_edit_window_max_minutes`, the cap on what any tenant's `OrderSettings.editWindowMinutes` may be set to — that applies uniformly to every tenant and has no `tenant_id` at all. It is deliberately NOT a `PlanFeature` even though it is "one number the super admin sets": axis (a) is plan-default-then-per-tenant-override, and this value has no plan dimension and no override dimension — bending it to fit the axis would let a per-tenant `Entitlement` quietly defeat the word "cap" in its own name. Adding the next platform-wide constant is a nullable column here, never a new table. | Same as `plans`: readable by every `app_web` request, writable by `app_web` — the super-admin-only route is the actual enforcement (`src/server/platform-settings.ts`), not a DB-level restriction, matching how `plans` itself is policed. No RLS: there is exactly one row and it names nobody. |

## Tables that exist BEFORE any tenant does

| Table | Why it is global |
|---|---|
| `demo_requests` | B3's public form runs at `app.{DOMAIN}/demo-request`, with no session and no tenant — the row is created by a stranger. It **never** creates a tenant; the admin approves it. It holds a prospect's WhatsApp number and physical address, so the generic policy template cannot apply and leaving it unpoliced would expose every prospect to every merchant connection. Policy: **INSERT only for `app_web`, with no SELECT at all**; SELECT/UPDATE restricted to `app.actor_role = 'super_admin'`; DELETE only for `app_system` (the daily sweep past `purgeAfter`). `ipHash` is an **HMAC** under `ENCRYPTION_KEY`, never a bare hash — a plain hash of an IPv4 address is brute-forceable over the whole address space and de-identifies nothing. |
| `webhook_endpoints` | One n8n endpoint receives every tenant's events. A tenant must never be able to add one, so it cannot be tenant-owned. Super admin only. |
| `tenants` | The ISOLATION ROOT. It cannot carry a `tenant_id` pointing at itself, and it is the table every other policy's `current_setting('app.tenant_id')` is compared against. Policed by its own named policies (migration 0001): a merchant reads only the tenant they are a member of, `proxy.ts` resolves a hostname before any context exists, and only a super admin sees the set. Listed here in Phase 6 because the file's own rule says every non-tenant-owned table needs a line — and because `tests/integration/rls-coverage.test.ts` now reads this list mechanically, where an unexplained absence is indistinguishable from a forgotten table. |

## Retention

Two of these hold personal data and therefore need a stated lifetime (Phase 6):

- `demo_requests` — `purgeAfter`, defaulting to +30 days, swept daily. A rejected request is
  deleted on schedule, which is what B3's Arabic notice promises.
- `tenant_tombstones` — minimal and slug-hashed by design, but "forever" is not a retention
  policy. Phase 6 states the lifetime.

`dsr_requests` and `platform_audit_logs` are compliance records; their retention is the
statutory one, stated in Phase 6's privacy copy.

### What Phase 5 added here, and what it deliberately did not

Phase 5 writes `orders`, `order_items`, `tenant_counters`, `payments` and `gateway_configs` for
the first time. **All five are tenant-owned**, were already in migration 0001's `tenant_tables`
array, and are destroyed by the purge cascade like everything else. No table was added, and no
table was moved into this file.

That was a decision, not an omission (`docs/DECISIONS.md`, decision (b)). Order records now
collide with statutory bookkeeping retention — but the obligation is the **merchant's**: they are
the controller and the taxpayer, the platform is a processor for order data, and Q18 discharges
the platform's duty by delivering them a complete copy at suspension (which, after decision (a),
now contains the full order ledger). Keeping a shadow ledger the platform could not lawfully
re-associate with anyone would have meant new global tables holding a stranger's phone number
forever — the exact retention the purge exists to end.

What survives instead is an **aggregate** on the existing `platform_audit_logs` row for
`tenant.purged`: `ordersPurged`, `paidOrdersPurged`, `orderGrossAgorot` and `lastOrderAt`. Four
numbers, so the platform can answer "how much trade went through this account" in a dispute. No
customer name, no phone number, no per-order row — and `tenant_tombstones` is untouched, because
it records facts about the deletion, not about the business.

### What Phase 8 added here, and what it deliberately did not

Phase 8 writes `order_settings`, `coupons`, `coupon_redemptions` and `order_history_entries` for
the first time, plus new columns on `orders` itself (`tracking_code`, `delivery_address`,
`delivery_area`, …). **All four new tables are tenant-owned**, carry `tenant_id`, and are policed
by the exact generic RLS template — added in migration `20260812010000_phase8_cart_coupons_orders`
rather than migration 0001, because they did not exist yet, but the template and the roles are the
same ones. None of them holds anything migration 0001's threat model did not already cover: a
tracking code is a bearer-style credential to ONE order (guarded by the phone-last-4 check and rate
limiting, not by RLS, since the storefront route runs unauthenticated by design — see
`src/server/orders/self-service.ts`), and a delivery address is customer PII exactly like
`Order.customerName`/`customerPhone` already were from Phase 5, inheriting the same purge and
suspension-export treatment (decision (a) still applies unchanged: `readOrdersForExport` was never
extended to select the new columns, so neither export channel gains an address it did not already
lack a name and phone for).

The one GLOBAL addition is `platform_settings` (above) — a single-row platform constant with no
tenant dimension, not a shadow ledger of anything tenant-owned.

---

## What Phase 9 added here

Phase 9 adds **fifteen tenant-owned tables and exactly two global ones.**

### The two global additions

| Table | Why it is global | Policy |
|---|---|---|
| `carriers` | A delivery company is the **platform's** asset, not a merchant's row. The same «شركة التوصيل» serves forty shops, and its price list changes once, centrally. Giving each tenant its own copy of "Yazan Express exists" would mean forty rows to update and thirty-nine chances to miss one. Exactly the reasoning that makes `plans` global. | No RLS — there is no `tenant_id` to key the generic template on, and unlike `users` or `sessions` there is nothing personal here: a delivery company's price list is not a secret. `SELECT` to `app_web` (a merchant must be able to see the carrier they were assigned) and `app_system`; writes to `app_web`, with the super-admin-only route as the actual enforcement, matching `plans`. |
| `carrier_rates` | The rate card belongs to the carrier, one row per (carrier, zone name). | As `carriers`. |

**`tenant_carriers` is deliberately NOT here.** Which carriers a given merchant may use *is*
tenant-owned, carries `tenant_id`, and is policed by the generic template. The split is the point:
the catalogue is global, the assignment is not. Its foreign key to `carriers` is `ON DELETE
RESTRICT` rather than `CASCADE`, so deleting a carrier that live merchants depend on fails loudly
instead of silently un-assigning them — `Carrier.hidden` is the correct way to retire one, the same
shape `Plan.hidden` already uses for the demo plan.

### Why the merchant's zones are tenant-owned even though they are copied from a global table

`DeliveryZone` / `DeliveryZoneTown` hold what a shop charges *its own customer*. They are seeded
from a carrier's rate card by **copy**, and `seededFromCarrierId` is a plain nullable column rather
than a foreign key precisely so the copy survives the carrier being retired. A live link would mean
a platform-side rate change silently repricing forty checkouts overnight, which is an outage, not
a feature.

### The one that needed thinking about, and stayed tenant-owned anyway

`analytics_events` and its three daily rollups are tenant-owned and fully policed, even though the
nightly job that reads them is a cross-tenant sweep. The sweep follows invariant 8 — it runs as
`app_system` only to enumerate tenant ids, then fans out into per-tenant jobs that each write
through `withTenantTxn` as `app_web` with `app.tenant_id` set. `app_system` keeps `SELECT` only.
The temptation is to let `app_system` write the rollups directly ("they're only counters"); that
would hand a cross-tenant **write** path to the one role whose read policy is `USING (true)`, so
the Phase 9 migration says so in a comment next to the GRANTs.

`customers` is tenant-owned and holds PII — but no PII the tenant did not already hold. It is an
index over `orders`, keyed on the phone number an order already stores, and it dies in the same
purge cascade. It introduces no new class of personal data and therefore no new obligation beyond
the ones Phase 5 and Phase 6 already discharge.
