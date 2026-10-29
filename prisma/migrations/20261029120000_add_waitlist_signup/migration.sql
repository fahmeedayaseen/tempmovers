-- ============================================================================
-- TempMovers — launch waitlist
--
-- Prepared by VASRUE Digital Media (Clinton Douglas IV), 29 October 2026.
-- Built from Carl's waitlist work order (29 Oct 2026), §4.
--
-- Additive only: one new enum and one new table. No existing model, enum,
-- column or migration is modified, reordered or touched, so the frozen
-- migration set is unchanged and this applies cleanly on top of it.
-- ============================================================================

-- CreateEnum
CREATE TYPE "WaitlistAudience" AS ENUM ('CUSTOMER', 'WORKER');

-- CreateTable
CREATE TABLE "WaitlistSignup" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "audience" "WaitlistAudience" NOT NULL,
    "zipCode" TEXT,
    "interests" TEXT[],
    "hasTruck" BOOLEAN,
    "firstName" TEXT,
    "source" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WaitlistSignup_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WaitlistSignup_audience_idx" ON "WaitlistSignup"("audience");

-- CreateIndex
CREATE INDEX "WaitlistSignup_zipCode_idx" ON "WaitlistSignup"("zipCode");

-- CreateIndex
CREATE UNIQUE INDEX "WaitlistSignup_email_audience_key" ON "WaitlistSignup"("email", "audience");
