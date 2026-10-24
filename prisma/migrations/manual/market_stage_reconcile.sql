-- Market Management: reconcile MarketStage to the spec's 7 stages, mapping
-- existing rows safely (NO drop-and-recreate that would lose market data).
--
-- Old → New mapping (per approved direction):
--   PIPELINE          -> PLANNING
--   SUPPLY_BUILD      -> CARRIER_RECRUITMENT
--   CONTROLLED_LAUNCH -> SOFT_LAUNCH
--   EXPANSION_READY   -> ACTIVE
--   PAUSED            -> PAUSED  (unchanged)
--   (new)             -> COMING_SOON, CLOSED
--
-- PostgreSQL approach: ALTER TYPE ADD VALUE cannot run in a txn with usage and
-- you cannot DROP enum values in use. Safest portable path: create the new
-- enum, migrate the column with an explicit mapping, then swap. Run inside a
-- single transaction.

BEGIN;

-- 1. New enum type with the 7 spec stages.
CREATE TYPE "MarketStage_new" AS ENUM (
  'PLANNING', 'CARRIER_RECRUITMENT', 'COMING_SOON', 'SOFT_LAUNCH', 'ACTIVE', 'PAUSED', 'CLOSED'
);

-- 2. Drop the old default so the type swap isn't blocked by it.
ALTER TABLE "LaunchMarket" ALTER COLUMN "stage" DROP DEFAULT;

-- 3. Convert the column, mapping every existing value explicitly.
ALTER TABLE "LaunchMarket" ALTER COLUMN "stage" TYPE "MarketStage_new"
  USING (
    CASE "stage"::text
      WHEN 'PIPELINE'          THEN 'PLANNING'
      WHEN 'SUPPLY_BUILD'      THEN 'CARRIER_RECRUITMENT'
      WHEN 'CONTROLLED_LAUNCH' THEN 'SOFT_LAUNCH'
      WHEN 'EXPANSION_READY'   THEN 'ACTIVE'
      WHEN 'PAUSED'            THEN 'PAUSED'
      ELSE 'PLANNING'  -- safety net for any unexpected legacy value
    END
  )::"MarketStage_new";

-- 4. Swap the types and restore a default.
DROP TYPE "MarketStage";
ALTER TYPE "MarketStage_new" RENAME TO "MarketStage";
ALTER TABLE "LaunchMarket" ALTER COLUMN "stage" SET DEFAULT 'PLANNING';

-- 5. New per-market service controls (default false — no service auto-enables).
ALTER TABLE "LaunchMarket"
  ADD COLUMN IF NOT EXISTS "customerBookingEnabled"    boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "moverRecruitmentEnabled"   boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "driverRecruitmentEnabled"  boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "carrierRecruitmentEnabled" boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "dispatchSupportEnabled"    boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "freightBrokerageEnabled"   boolean NOT NULL DEFAULT false;

-- 6. Market audit history table.
CREATE TABLE IF NOT EXISTS "MarketChangeLog" (
  "id"            text PRIMARY KEY,
  "marketId"      text NOT NULL REFERENCES "LaunchMarket"("id"),
  "previousStage" "MarketStage",
  "newStage"      "MarketStage",
  "changedFields" jsonb NOT NULL,
  "changedById"   text NOT NULL,
  "changeReason"  text,
  "overrideUsed"  boolean NOT NULL DEFAULT false,
  "createdAt"     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "MarketChangeLog_marketId_createdAt_idx" ON "MarketChangeLog" ("marketId", "createdAt");

COMMIT;

-- NOTE: this hand-written SQL documents the safe mapping. In the dev
-- environment, generate the canonical Prisma migration with
-- `npx prisma migrate dev` and RECONCILE it against this file — Prisma may
-- express the enum change differently; the explicit CASE mapping above is the
-- part that must be preserved so no existing market row is lost or mis-mapped.
