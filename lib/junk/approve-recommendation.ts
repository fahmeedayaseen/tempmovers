import { prisma } from "@/lib/db";
import { Prisma, type UserRole } from "@prisma/client";
import { resolvePaymentPolicy } from "@/lib/payments/policy";
import { minimumAcceptablePriceCents } from "@/lib/junk/market-intelligence";
import { requireMarketAccessByCode } from "@/lib/market-access";
import type { JunkVolumeTierCode, JunkServiceLevelCode } from "@/lib/junk/pricing";
import {
  applyApprovedRecommendationToTable, assertApprovable, parseJunkPriceTableOverride, stampLegacyFullServiceApproval,
  RecommendationNotApprovedError, RecommendationNotFoundError, ApprovalConflictError, MarketPolicyNotApprovedError,
  ApprovalForbiddenError,
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

    // Market authorization (correction item 3): the admin must be authorized for
    // THIS market. Throws ForbiddenError on a cross-market approval attempt.
    await requireMarketAccessByCode({ userId: args.actingUserId, marketCode: rec.marketCode });

    // Require a market-specific owner-approved payment policy (correction item 4):
    // prices may not be approved on an unverified national/default policy.
    const policy = await resolvePaymentPolicy(rec.marketCode, tx);
    if (policy.source !== "market" || policy.carlApprovedAt == null) throw new MarketPolicyNotApprovedError();

    // Recompute the CURRENT cost floor from this market's approved policy, so a
    // stale recommendation (floor moved) or a below-floor price is rejected.
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
          actorRole: args.actingRole,
          authorizationDecision: "AUTHORIZED",
          marketCode: rec.marketCode, serviceLevel, volumeTier,
          approvedPriceCents: rec.recommendedPriceCents, floorCents: currentFloorCents,
          policyApprovedAt: policy.carlApprovedAt?.toISOString() ?? null,
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

// ---------------------------------------------------------------------------
// Controlled legacy-pricing approval (correction item 2).
//
// A market's pre-existing top-level junkPriceTable (tiersCents/itemsCents) is
// NOT billable until an authorised admin, for THAT market, explicitly blesses
// it. This stamps the documented approval marker + an audit entry in one
// transaction. It does not change any price value or any existing booking
// snapshot — it only records that the legacy Full-Service rates are approved.
// ---------------------------------------------------------------------------
export async function approveLegacyFullServicePricing(
  args: { marketCode: string; actingUserId: string; actingRole: UserRole },
): Promise<{ marketCode: string; pricingRuleId: string; approvedAt: string }> {
  if (!RECOMMENDATION_APPROVER_ROLES.includes(args.actingRole)) {
    throw new ApprovalForbiddenError();
  }
  return prisma.$transaction(async (tx: TxClient) => {
    await requireMarketAccessByCode({ userId: args.actingUserId, marketCode: args.marketCode });
    const rule = await tx.pricingRule.findUnique({ where: { marketCode: args.marketCode } });
    if (!rule) throw new RecommendationNotApprovedError(`No PricingRule for ${args.marketCode} to approve legacy pricing on.`);
    const approvedAt = new Date();
    const next = stampLegacyFullServiceApproval(parseJunkPriceTableOverride(rule.junkPriceTable), { approvedAt, approvedBy: args.actingUserId });
    await tx.pricingRule.update({ where: { id: rule.id }, data: { junkPriceTable: next as Prisma.InputJsonValue } });
    await tx.auditLog.create({
      data: {
        actorId: args.actingUserId, action: "JUNK_LEGACY_PRICING_APPROVED",
        entityType: "PricingRule", entityId: rule.id,
        details: { marketCode: args.marketCode, actorRole: args.actingRole, authorizationDecision: "AUTHORIZED", approvedAt: approvedAt.toISOString() },
      },
    });
    return { marketCode: args.marketCode, pricingRuleId: rule.id, approvedAt: approvedAt.toISOString() };
  });
}
