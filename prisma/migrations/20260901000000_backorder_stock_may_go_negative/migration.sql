-- -----------------------------------------------------------------------------
-- A backorder is a negative balance, and Phase 9 made one unrepresentable.
--
-- `decrementStockInTx` (src/server/catalogue/stock.ts) documents the rule in its own docblock:
--
--     `track_and_allow` decrements without the `gte` guard, which is how a backorder is
--     recorded rather than refused.
--
-- Phase 9's migration then added three CHECK constraints forbidding exactly that:
--
--     product_variants_amounts_nonneg        ... "stock_qty" >= 0 AND ...
--     products_phase9_amounts_nonneg         ... "stock_qty" >= 0 AND ...
--     product_variants_stock_not_negative    CHECK ("stock_qty" >= 0)
--
-- So a shop with `stock_policy = 'track_and_allow'` — the policy whose entire purpose is to accept
-- an order at a zero balance — raised
--
--     23514: new row for relation "products" violates check constraint
--            "products_phase9_amounts_nonneg"
--
-- inside the checkout transaction the moment the balance ran out. Not a degraded checkout: an
-- exception thrown out of `tx.product.updateMany()`, rolling the whole order back. The customer
-- sees a failure, and nothing records that they tried.
--
-- `tests/integration/phase9-variants-stock.test.ts > decrementStockInTx > lets track_and_allow go
-- negative, which is what a backorder is` asserts `stockQty === -3` and has been failing since the
-- day it was written. It was never read, because the test suite has never run anywhere it could
-- be read: the CI job that would have run it dies in its minio fixture before `pnpm test` starts,
-- and GATES.cmd's own header records that the suite cannot run on Windows.
--
-- WHAT THE THIRD CONSTRAINT WAS ACTUALLY FOR, because deleting it without saying so would lose a
-- real intention. Its comment reads:
--
--     The stock invariant that matters. `track_and_block` promises the storefront will not
--     oversell; this is the backstop if the FOR UPDATE decrement in the order transaction is
--     ever bypassed by a plain Prisma `update`.
--
-- That intention is correct and it is kept below — for `products`, where it can be expressed.
-- `stock_policy` is a column ON `products`, so the guard becomes conditional and lands on exactly
-- the policy it was written for.
--
-- It CANNOT be kept for `product_variants`. A variant's policy lives on its parent `products` row,
-- and a Postgres CHECK constraint may not contain a subquery — there is no expression on
-- `product_variants` alone that can ask which policy applies. The alternatives were both worse
-- than dropping it: denormalising `stock_policy` onto every variant buys a backstop and pays for
-- it with a synchronisation bug, and a trigger replaces a declarative guarantee with procedural
-- code on the hot path of every checkout.
--
-- Dropping it costs the backstop, not the guarantee. The guarantee is the conditional `updateMany`
-- in the same statement as the write:
--
--     UPDATE product_variants SET stock_qty = stock_qty - 2 WHERE id = … AND stock_qty >= 2
--
-- which takes the row lock and tests the condition atomically, and which the dropped constraint's
-- own comment concedes it was never a substitute for ("a CHECK cannot serialise two concurrent
-- readers").
-- -----------------------------------------------------------------------------

-- 1. Variants: keep the money guard, drop the stock guard.
ALTER TABLE "product_variants" DROP CONSTRAINT IF EXISTS "product_variants_amounts_nonneg";
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_amounts_nonneg" CHECK (
  "price_agorot_override" IS NULL OR "price_agorot_override" >= 0
);

ALTER TABLE "product_variants" DROP CONSTRAINT IF EXISTS "product_variants_stock_not_negative";

-- 2. Products: keep the money guards, and make the stock guard say what it meant — no overselling
--    under `track_and_block`, and nothing at all to say about the other two policies.
--    `untracked` is skipped by the service before any UPDATE is issued; `track_and_allow` is
--    required to go negative.
ALTER TABLE "products" DROP CONSTRAINT IF EXISTS "products_phase9_amounts_nonneg";
ALTER TABLE "products" ADD CONSTRAINT "products_phase9_amounts_nonneg" CHECK (
  ("compare_at_price_agorot" IS NULL OR "compare_at_price_agorot" >= 0)
  AND ("low_stock_threshold" IS NULL OR "low_stock_threshold" >= 0)
);

ALTER TABLE "products" DROP CONSTRAINT IF EXISTS "products_block_policy_stock_nonneg";
ALTER TABLE "products" ADD CONSTRAINT "products_block_policy_stock_nonneg" CHECK (
  "stock_policy" <> 'track_and_block' OR "stock_qty" >= 0
);
