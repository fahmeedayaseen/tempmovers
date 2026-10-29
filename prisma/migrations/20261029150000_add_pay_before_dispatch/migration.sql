-- ============================================================================
-- TempMovers — pay before dispatch
--
-- Prepared by VASRUE Digital Media (Clinton Douglas IV), 29 October 2026.
-- Built from Carl's pay-before-dispatch work order and the platform payment
-- structure spec v1.0 (29 Oct 2026), sections 2 to 8.
--
-- Additive only: new enums and new tables, nothing else. No existing model,
-- enum, column, index or migration is modified, reordered or dropped, so the
-- frozen migration set is untouched. New tables refer to jobs, loads and
-- workers by id rather than adding columns to those tables.
-- ============================================================================

-- CreateEnum
CREATE TYPE "FundingEntityType" AS ENUM ('JOB', 'LOAD', 'FREIGHT_LOAD');

-- CreateEnum
CREATE TYPE "FundingState" AS ENUM ('UNPAID', 'ACTION_REQUIRED', 'PROCESSING', 'COLLECTED', 'PARTIALLY_REFUNDED', 'REFUNDED', 'FAILED', 'RETURNED', 'DISPUTED', 'CANCELED');

-- CreateEnum
CREATE TYPE "FundingPurpose" AS ENUM ('INITIAL', 'CHANGE_ORDER');

-- CreateEnum
CREATE TYPE "ChangeOrderKind" AS ENUM ('EXTRA_HOURS', 'EXTRA_HELPER', 'EXTRA_ITEMS', 'DISPOSAL_OVERAGE', 'OTHER');

-- CreateEnum
CREATE TYPE "ChangeOrderStatus" AS ENUM ('PROPOSED', 'ACCEPTED', 'PAID', 'DECLINED', 'CANCELED');

-- CreateEnum
CREATE TYPE "AllocationRecipient" AS ENUM ('PLATFORM', 'PROTECTION', 'HAULER', 'HELPER', 'WORKER', 'CARRIER', 'DISPOSAL', 'CUSTOMER_REFUND');

-- CreateEnum
CREATE TYPE "AllocationState" AS ENUM ('ESTIMATED', 'EARNED_PENDING_REVIEW', 'APPROVED_AWAITING_FUNDS', 'RELEASED', 'TRANSFERRED', 'HELD', 'RETAINED', 'REFUNDED', 'EXCEPTION');

-- CreateEnum
CREATE TYPE "DisposalState" AS ENUM ('ESTIMATED', 'RECEIPT_SUBMITTED', 'APPROVED', 'HELD', 'REJECTED');

-- CreateEnum
CREATE TYPE "SettlementState" AS ENUM ('SETTLED', 'EXCEPTION');

-- CreateEnum
CREATE TYPE "PaymentExceptionKind" AS ENUM ('CREDIT_TERMS', 'EVIDENCE_WAIVER', 'RECEIPT_WAIVER');

-- CreateTable
CREATE TABLE "QuoteVersion" (
    "id" TEXT NOT NULL,
    "entityType" "FundingEntityType" NOT NULL,
    "entityId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "policyVersion" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'usd',
    "totalCents" INTEGER NOT NULL,
    "lines" JSONB NOT NULL,
    "plan" JSONB,
    "createdByUserId" TEXT,
    "acceptedAt" TIMESTAMP(3),
    "acceptedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "QuoteVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FundingAttempt" (
    "id" TEXT NOT NULL,
    "entityType" "FundingEntityType" NOT NULL,
    "entityId" TEXT NOT NULL,
    "purpose" "FundingPurpose" NOT NULL DEFAULT 'INITIAL',
    "quoteVersionId" TEXT,
    "changeOrderId" TEXT,
    "stripePaymentIntentId" TEXT NOT NULL,
    "stripeChargeId" TEXT,
    "paymentMethodType" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'usd',
    "amountCents" INTEGER NOT NULL,
    "collectedCents" INTEGER NOT NULL DEFAULT 0,
    "refundedCents" INTEGER NOT NULL DEFAULT 0,
    "disputedCents" INTEGER NOT NULL DEFAULT 0,
    "state" "FundingState" NOT NULL DEFAULT 'UNPAID',
    "failureReason" TEXT,
    "collectedAt" TIMESTAMP(3),
    "fundsAvailableAt" TIMESTAMP(3),
    "lastSyncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FundingAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChangeOrder" (
    "id" TEXT NOT NULL,
    "entityType" "FundingEntityType" NOT NULL,
    "entityId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "kind" "ChangeOrderKind" NOT NULL,
    "status" "ChangeOrderStatus" NOT NULL DEFAULT 'PROPOSED',
    "deltaCents" INTEGER NOT NULL,
    "lines" JSONB NOT NULL,
    "plan" JSONB,
    "reason" TEXT NOT NULL,
    "proposedByUserId" TEXT NOT NULL,
    "consentText" TEXT,
    "acceptedAt" TIMESTAMP(3),
    "acceptedByUserId" TEXT,
    "declinedAt" TIMESTAMP(3),
    "paidAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChangeOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentSettlement" (
    "id" TEXT NOT NULL,
    "entityType" "FundingEntityType" NOT NULL,
    "entityId" TEXT NOT NULL,
    "state" "SettlementState" NOT NULL,
    "policyVersion" TEXT NOT NULL,
    "collectedCents" INTEGER NOT NULL,
    "finalTotalCents" INTEGER NOT NULL,
    "refundCents" INTEGER NOT NULL DEFAULT 0,
    "platformFeeCents" INTEGER NOT NULL DEFAULT 0,
    "feeBasisCents" INTEGER NOT NULL DEFAULT 0,
    "feeBps" INTEGER,
    "exceptionReason" TEXT,
    "details" JSONB,
    "settledByUserId" TEXT NOT NULL,
    "settledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentSettlement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentAllocation" (
    "id" TEXT NOT NULL,
    "settlementId" TEXT NOT NULL,
    "entityType" "FundingEntityType" NOT NULL,
    "entityId" TEXT NOT NULL,
    "recipient" "AllocationRecipient" NOT NULL,
    "workerId" TEXT,
    "assignmentId" TEXT,
    "payoutId" TEXT,
    "amountCents" INTEGER NOT NULL,
    "basis" JSONB,
    "state" "AllocationState" NOT NULL,
    "stripeTransferId" TEXT,
    "transferIdempotencyKey" TEXT,
    "transferredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentAllocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DisposalExpense" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "estimatedCents" INTEGER NOT NULL,
    "actualCents" INTEGER,
    "receiptKey" TEXT,
    "receiptFingerprint" TEXT,
    "payeeWorkerId" TEXT,
    "state" "DisposalState" NOT NULL DEFAULT 'ESTIMATED',
    "submittedAt" TIMESTAMP(3),
    "reviewedByUserId" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DisposalExpense_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentException" (
    "id" TEXT NOT NULL,
    "entityType" "FundingEntityType" NOT NULL,
    "entityId" TEXT NOT NULL,
    "kind" "PaymentExceptionKind" NOT NULL,
    "reason" TEXT NOT NULL,
    "authorizedByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "revokedByUserId" TEXT,

    CONSTRAINT "PaymentException_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentPolicyConfig" (
    "id" TEXT NOT NULL,
    "marketCode" TEXT NOT NULL,
    "junkPlatformFeeBps" INTEGER NOT NULL DEFAULT 3000,
    "helperHourlyCents" INTEGER NOT NULL DEFAULT 3000,
    "helperMinimumMinutes" INTEGER NOT NULL DEFAULT 120,
    "helperIncrementMinutes" INTEGER NOT NULL DEFAULT 15,
    "haulerFloorCents" INTEGER NOT NULL DEFAULT 4000,
    "truckAllowanceCents" INTEGER NOT NULL DEFAULT 1000,
    "disposalEstimatesCents" JSONB,
    "disposalAddersCents" JSONB,
    "disposalAutoApproveCents" INTEGER NOT NULL DEFAULT 20000,
    "reviewWindowHours" INTEGER NOT NULL DEFAULT 24,
    "achEnabled" BOOLEAN NOT NULL DEFAULT false,
    "carlApprovedAt" TIMESTAMP(3),
    "updatedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentPolicyConfig_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "QuoteVersion_entityType_entityId_idx" ON "QuoteVersion"("entityType", "entityId");

-- CreateIndex
CREATE UNIQUE INDEX "QuoteVersion_entityType_entityId_version_key" ON "QuoteVersion"("entityType", "entityId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "FundingAttempt_changeOrderId_key" ON "FundingAttempt"("changeOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "FundingAttempt_stripePaymentIntentId_key" ON "FundingAttempt"("stripePaymentIntentId");

-- CreateIndex
CREATE INDEX "FundingAttempt_entityType_entityId_idx" ON "FundingAttempt"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "ChangeOrder_entityType_entityId_status_idx" ON "ChangeOrder"("entityType", "entityId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ChangeOrder_entityType_entityId_version_key" ON "ChangeOrder"("entityType", "entityId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentSettlement_entityType_entityId_key" ON "PaymentSettlement"("entityType", "entityId");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentAllocation_stripeTransferId_key" ON "PaymentAllocation"("stripeTransferId");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentAllocation_transferIdempotencyKey_key" ON "PaymentAllocation"("transferIdempotencyKey");

-- CreateIndex
CREATE INDEX "PaymentAllocation_settlementId_idx" ON "PaymentAllocation"("settlementId");

-- CreateIndex
CREATE INDEX "PaymentAllocation_entityType_entityId_idx" ON "PaymentAllocation"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "PaymentAllocation_assignmentId_idx" ON "PaymentAllocation"("assignmentId");

-- CreateIndex
CREATE UNIQUE INDEX "DisposalExpense_jobId_key" ON "DisposalExpense"("jobId");

-- CreateIndex
CREATE UNIQUE INDEX "DisposalExpense_receiptFingerprint_key" ON "DisposalExpense"("receiptFingerprint");

-- CreateIndex
CREATE INDEX "PaymentException_entityType_entityId_kind_idx" ON "PaymentException"("entityType", "entityId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentPolicyConfig_marketCode_key" ON "PaymentPolicyConfig"("marketCode");
