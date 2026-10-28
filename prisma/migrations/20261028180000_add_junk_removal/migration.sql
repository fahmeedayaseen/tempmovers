-- ============================================================================
-- TempMovers — migration 004
-- Junk removal service
--
-- Prepared by VASRUE Digital Media (Clinton Douglas IV), 28 October 2026.
-- Built from Carl's junk-removal build spec (11-page revision, 27 Oct 2026).
--
-- Additive only. Nothing is dropped, renamed or retyped, and no existing row
-- changes meaning:
--   - JobType gains JUNK_REMOVAL; WorkerType gains JUNK_HAULER and JUNK_HELPER.
--   - New columns all carry defaults (false / 30 / 25) or are nullable.
--   - JunkRemovalDetail is a new 1:1 table hanging off Job.
--
-- Two places where this deliberately differs from the spec's wording, both
-- to make the spec's own intent true at runtime:
--   - The per-market switch is LaunchMarket.junkRemovalEnabled, beside the
--     other per-service controls. FeatureFlag.enabledServiceTypes is advisory
--     and gates nothing, so it could not keep junk to Indianapolis.
--   - Junk pricing is DEDUCT_FROM_PROVIDER in behaviour: one all-in customer
--     price, the take-rate taken out of it, matching the spec's worked tables
--     and its "no customer-visible surcharge" rule.
--
-- PostgreSQL 12+ allows several ADD VALUE statements in one migration as long
-- as the new values are not used in the same transaction. None are.
-- ============================================================================

-- CreateEnum
CREATE TYPE "JunkVolumeTier" AS ENUM ('SINGLE_ITEM', 'EIGHTH', 'QUARTER', 'HALF', 'THREE_QUARTER', 'FULL');

-- CreateEnum
CREATE TYPE "JunkItemLocation" AS ENUM ('CURBSIDE', 'INSIDE_GROUND', 'BASEMENT', 'UPSTAIRS');

-- CreateEnum
CREATE TYPE "JunkPricingMode" AS ENUM ('VOLUME', 'ITEMS');

-- CreateEnum
CREATE TYPE "JunkCrewRole" AS ENUM ('HAULER', 'HELPER');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "WorkerType" ADD VALUE 'JUNK_HAULER';
ALTER TYPE "WorkerType" ADD VALUE 'JUNK_HELPER';

-- AlterEnum
ALTER TYPE "JobType" ADD VALUE 'JUNK_REMOVAL';

-- AlterTable
ALTER TABLE "WorkerProfile" ADD COLUMN     "junkRemovalEnabled" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Assignment" ADD COLUMN     "junkCrewRole" "JunkCrewRole";

-- AlterTable
ALTER TABLE "PricingRule" ADD COLUMN     "junkHelperSharePercent" INTEGER NOT NULL DEFAULT 25,
ADD COLUMN     "junkPriceTable" JSONB,
ADD COLUMN     "junkTakeRatePercent" INTEGER NOT NULL DEFAULT 30;

-- AlterTable
ALTER TABLE "LaunchMarket" ADD COLUMN     "junkRemovalEnabled" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "JunkRemovalDetail" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "pricingMode" "JunkPricingMode" NOT NULL,
    "volumeTier" "JunkVolumeTier",
    "items" JSONB,
    "itemCategories" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "itemNotes" TEXT,
    "itemLocation" "JunkItemLocation" NOT NULL,
    "hasHeavyItems" BOOLEAN NOT NULL DEFAULT false,
    "specialItems" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "photoKeys" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "beforePhotoKeys" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "afterPhotoKeys" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "dumpReceiptKey" TEXT,
    "estimatedDumpFeeCents" INTEGER,
    "servicePriceCents" INTEGER NOT NULL,
    "surchargesCents" INTEGER NOT NULL DEFAULT 0,
    "takeRatePercent" INTEGER NOT NULL,
    "platformTakeCents" INTEGER NOT NULL,
    "crewPoolCents" INTEGER NOT NULL,
    "helpersRequired" INTEGER NOT NULL DEFAULT 0,
    "helperSharePercent" INTEGER NOT NULL,
    "haulerShareCents" INTEGER NOT NULL,
    "helperShareCents" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JunkRemovalDetail_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "JunkRemovalDetail_jobId_key" ON "JunkRemovalDetail"("jobId");

-- AddForeignKey
ALTER TABLE "JunkRemovalDetail" ADD CONSTRAINT "JunkRemovalDetail_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;

