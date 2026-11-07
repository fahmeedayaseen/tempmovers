-- ============================================================================
-- TempMovers — Market Pricing Intelligence (Phase 1)
--
-- Prepared 7 November 2026. Built from the Market-Based Dynamic Pricing
-- Intelligence directive v1.0 and Carl R. Newborne's Phase 1 authorization
-- (7 Nov 2026).
--
-- Additive only: four new enums, one new column with a safe default, and two
-- new tables. No existing model, enum, column, index or migration is modified,
-- reordered or dropped, so the frozen migration set and all Model B pricing,
-- billing and settlement behaviour are untouched.
--
-- Rollback: drop the two new tables, drop the four new enums, and drop the
-- "JunkRemovalDetail"."serviceLevel" column and the "JunkServiceLevel" enum.
-- No data migration is required because every existing junk booking defaults
-- to FULL_SERVICE, preserving its original pricing and settlement records.
-- ============================================================================

-- CreateEnum
CREATE TYPE "JunkServiceLevel" AS ENUM ('ECONOMY', 'FULL_SERVICE');

-- CreateEnum
CREATE TYPE "CompetitorPricingBasis" AS ENUM ('ITEM', 'VOLUME', 'TRUCKLOAD', 'HOURLY');

-- CreateEnum
CREATE TYPE "CompetitorServiceType" AS ENUM ('CURBSIDE', 'FULL_SERVICE', 'SPECIALIZED');

-- CreateEnum
CREATE TYPE "BenchmarkConfidence" AS ENUM ('HIGH', 'MEDIUM', 'LOW');

-- CreateEnum
CREATE TYPE "MarketPriceRecommendationStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'SUPERSEDED');

-- AlterTable: new service level on existing junk bookings. NOT NULL with a
-- default of FULL_SERVICE so every pre-existing row keeps its original service
-- and pricing; nothing is recomputed or re-settled.
ALTER TABLE "JunkRemovalDetail" ADD COLUMN "serviceLevel" "JunkServiceLevel" NOT NULL DEFAULT 'FULL_SERVICE';

-- CreateTable
CREATE TABLE "CompetitorObservation" (
    "id" TEXT NOT NULL,
    "marketCode" TEXT NOT NULL,
    "zipCode" TEXT,
    "competitor" TEXT NOT NULL,
    "sourceUrl" TEXT NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL,
    "serviceType" "CompetitorServiceType" NOT NULL,
    "pricingBasis" "CompetitorPricingBasis" NOT NULL,
    "comparableTier" TEXT,
    "truckCapacityCubicYards" INTEGER,
    "includesLabor" BOOLEAN NOT NULL DEFAULT true,
    "includesDisposal" BOOLEAN NOT NULL DEFAULT true,
    "includesStairs" BOOLEAN NOT NULL DEFAULT false,
    "minimumChargeCents" INTEGER,
    "advertisedPriceCents" INTEGER NOT NULL,
    "additionalItemCents" INTEGER,
    "conditions" TEXT,
    "confidence" "BenchmarkConfidence" NOT NULL DEFAULT 'MEDIUM',
    "staleAfterDays" INTEGER NOT NULL DEFAULT 30,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CompetitorObservation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketPriceRecommendation" (
    "id" TEXT NOT NULL,
    "marketCode" TEXT NOT NULL,
    "serviceLevel" "JunkServiceLevel" NOT NULL,
    "volumeTier" "JunkVolumeTier" NOT NULL,
    "recommendedPriceCents" INTEGER NOT NULL,
    "floorPriceCents" INTEGER NOT NULL,
    "competitiveTargetCents" INTEGER,
    "discountBps" INTEGER,
    "benchmarkPriceCents" INTEGER,
    "benchmarkCompetitor" TEXT,
    "benchmarkObservationId" TEXT,
    "rationale" TEXT,
    "status" "MarketPriceRecommendationStatus" NOT NULL DEFAULT 'PENDING',
    "reviewedByUserId" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "approvedRateWrittenAt" TIMESTAMP(3),
    "effectiveAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MarketPriceRecommendation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CompetitorObservation_marketCode_serviceType_observedAt_idx" ON "CompetitorObservation"("marketCode", "serviceType", "observedAt");

-- CreateIndex
CREATE INDEX "CompetitorObservation_marketCode_active_idx" ON "CompetitorObservation"("marketCode", "active");

-- CreateIndex
CREATE INDEX "MarketPriceRecommendation_lookup_idx" ON "MarketPriceRecommendation"("marketCode", "serviceLevel", "volumeTier", "status");

-- CreateIndex
CREATE INDEX "MarketPriceRecommendation_status_idx" ON "MarketPriceRecommendation"("status");
