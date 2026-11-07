import { prisma } from "@/lib/db";
import { Prisma, type UserRole } from "@prisma/client";
import { resolvePaymentPolicy } from "@/lib/payments/policy";
import { minimumAcceptablePriceCents } from "@/lib/junk/market-intelligence";
import type { JunkVolumeTierCode, JunkServiceLevelCode } from "@/lib/junk/pricing";
import {
  applyApprovedRecommendationToTable, assertApprovable, parseJunkPriceTableOverride,
  RecommendationNotApprovedError, RecommendationNotFoundError, ApprovalConflictError,
  type RecommendationStatusValue,
} from "@/lib/junk/pricing-approval";

// ---------------------------------------------------------------------------
// Owner/admin price approval — authenticated, atomic, audited (correction 2).
//
// A single interactive transaction: recompute the current cost floor, run the
// pure guard (permission, status, floor), write the approved price into the
// market's PricingRule (into the recommendation's OWN service-level slot), flip
// the recommendation PENDING→APPROVED with a status-guarded update (optimistic
// concurrency / replay protection), and append an audit event. Any failure
// rolls the whole transaction back, so a price is never written without its
// matching recommendation state and audit entry.
//
// It does NOT set live-payment or Stripe state. The market's PAYMENT policy
// approval (PaymentPolicyConfig.carlApprovedAt) remains a separate owner action;
// the availability gate requires both.
// ---------------------------------------------------------------------------

export const RECOMMENDATION_APPROVER_ROLES: readonly UserRole[] = ["ADMIN", "FINANCE_ADMIN", "SUPER_ADMIN"];

export type ApproveRecommendationResult = {
  recommendationId: string;
  marketCode: string;
  serviceLevel: JunkServiceLevelCode;
  volumeTier: JunkVolumeTierCode;
  approvedPriceCents: number;
  floorCents: number;
  pricingRuleId: string;
  pricingRuleVersion: string;
};

type TxClient = Prisma.TransactionClient;

export async function approveMarketRecommendation(
  args: { recommendationId: string; actingUserId: string; actingRole: UserRole; effectiveAt?: Date },
): Promise<ApproveRecommendationResult> {
  return prisma.$transaction(async (tx: TxClient) => {
    const rec = await tx.marketPriceRecommendation.findUnique({ where: { id: args.recommendationId } });
    if (!rec) throw new RecommendationNotFoundError();

    const serviceLevel = rec.serviceLevel as JunkServiceLevelCode;
    const volumeTier = rec.volumeTier as JunkVolumeTierCode;

    // Recompute the CURRENT cost floor from this market's approved policy, so a
    // stale recommendation (floor moved) or a below-floor price is rejected.
    const policy = await resolvePaymentPolicy(rec.marketCode, tx);
    const currentFloorCents = minimumAcceptablePriceCents({ tier: volumeTier, serviceLevel, policy });

    assertApprovable({
      actingRole: args.actingRole,
      approverRoles: RECOMMENDATION_APPROVER_ROLES,
      status: rec.status as RecommendationStatusValue,
      recommendedPriceCents: rec.recommendedPriceCents,
      recordedFloorCents: rec.floorPriceCents,
      currentFloorCents,
    });

    // The market must already have a PricingRule to approve a price into (it is
    // the single authoritative source; we never spin up a parallel one here).
    const rule = await tx.pricingRule.findUnique({ where: { marketCode: rec.marketCode } });
    if (!rule) throw new RecommendationNotApprovedError(`Configure a PricingRule for ${rec.marketCode} before approving a junk price.`);

    const nextTable = applyApprovedRecommendationToTable(parseJunkPriceTableOverride(rule.junkPriceTable), {
      status: "APPROVED", serviceLevel, volumeTier,
      recommendedPriceCents: rec.recommendedPriceCents, floorPriceCents: rec.floorPriceCents,
    });
    const updatedRule = await tx.pricingRule.update({
      where: { id: rule.id },
      data: { junkPriceTable: nextTable as Prisma.InputJsonValue, active: true },
    });

    // Optimistic concurrency / replay guard: only the first APPROVE of a PENDING
    // row succeeds; a concurrent or duplicate approval claims 0 rows.
    const claim = await tx.marketPriceRecommendation.updateMany({
      where: { id: rec.id, status: "PENDING" },
      data: {
        status: "APPROVED",
        reviewedByUserId: args.actingUserId,
        reviewedAt: new Date(),
        approvedRateWrittenAt: new Date(),
        effectiveAt: args.effectiveAt ?? new Date(),
      },
    });
    if (claim.count !== 1) throw new ApprovalConflictError();

    await tx.auditLog.create({
      data: {
        actorId: args.actingUserId,
        action: "JUNK_PRICE_APPROVED",
        entityType: "MarketPriceRecommendation",
        entityId: rec.id,
        details: {
          marketCode: rec.marketCode, serviceLevel, volumeTier,
          approvedPriceCents: rec.recommendedPriceCents, floorCents: currentFloorCents,
          pricingRuleId: rule.id, pricingRuleVersion: updatedRule.updatedAt.toISOString(),
        },
      },
    });

    return {
      recommendationId: rec.id, marketCode: rec.marketCode, serviceLevel, volumeTier,
      approvedPriceCents: rec.recommendedPriceCents, floorCents: currentFloorCents,
      pricingRuleId: rule.id, pricingRuleVersion: updatedRule.updatedAt.toISOString(),
    };
  });
}
