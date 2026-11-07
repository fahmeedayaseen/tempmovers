import { prisma } from "@/lib/db";
import { Prisma, type UserRole } from "@prisma/client";
import { resolvePaymentPolicy } from "@/lib/payments/policy";
import { minimumAcceptablePriceCents } from "@/lib/junk/market-intelligence";
import { requireMarketAccessByCode } from "@/lib/market-access";
import type { JunkVolumeTierCode, JunkServiceLevelCode } from "@/lib/junk/pricing";
import {
  applyApprovedRecommendationToTable, applyLegacyFullServiceRates, assertApprovable, parseJunkPriceTableOverride,
  RecommendationNotApprovedError, RecommendationNotFoundError, ApprovalConflictError, MarketPolicyNotApprovedError,
  ApprovalForbiddenError,
  type RecommendationStatusValue, type LegacyFullServiceRates,
} from "@/lib/junk/pricing-approval";

/**
 * Lock a market's PricingRule row for the rest of the transaction
 * (SELECT ... FOR UPDATE). Both approval paths read-modify-write the single
 * junkPriceTable JSON, so concurrent approvals of DIFFERENT tiers/service levels
 * would otherwise clobber each other (lost update). The row lock serialises
 * them: the second approval blocks until the first commits, then reads the
 * already-updated table and merges its own slot, so every approved price is
 * retained. Returns the freshly-read, locked rule.
 */
async function lockPricingRule(tx: TxClient, marketCode: string) {
  const locked = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM "PricingRule" WHERE "marketCode" = ${marketCode} FOR UPDATE`;
  if (locked.length === 0) throw new RecommendationNotApprovedError(`Configure a PricingRule for ${marketCode} before approving a junk price.`);
  const rule = await tx.pricingRule.findUnique({ where: { id: locked[0].id } });
  if (!rule) throw new RecommendationNotApprovedError(`PricingRule for ${marketCode} disappeared mid-transaction.`);
  return rule;
}

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

    // Lock the market's PricingRule row so concurrent approvals of different
    // tiers/service levels serialise instead of clobbering the shared JSON.
    const rule = await lockPricingRule(tx, rec.marketCode);

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
// Controlled legacy-pricing approval (correction round 5, item 2).
//
// A market's pre-existing top-level prices are never billable on their own. To
// authorise them the admin passes the EXACT reviewed Full-Service rates; each
// is validated (positive, at/above the current floor for volume tiers) and
// written explicitly into the FULL_SERVICE service-level slot, with the approved
// values + scope recorded in the audit log. There is no blanket marker, so
// default example prices can never receive wholesale approval. Requires the
// market's owner-approved payment policy and market authorisation. Existing
// booking snapshots are untouched.
// ---------------------------------------------------------------------------
export async function approveLegacyFullServicePricing(
  args: { marketCode: string; actingUserId: string; actingRole: UserRole; rates: LegacyFullServiceRates },
): Promise<{ marketCode: string; pricingRuleId: string; approvedTiers: string[]; approvedItems: string[]; approvedAt: string }> {
  if (!RECOMMENDATION_APPROVER_ROLES.includes(args.actingRole)) throw new ApprovalForbiddenError();

  return prisma.$transaction(async (tx: TxClient) => {
    await requireMarketAccessByCode({ userId: args.actingUserId, marketCode: args.marketCode });

    // Require the market's own owner-approved payment policy (same bar as a
    // normal price approval) and validate each reviewed tier against its floor.
    const policy = await resolvePaymentPolicy(args.marketCode, tx);
    if (policy.source !== "market" || policy.carlApprovedAt == null) throw new MarketPolicyNotApprovedError();

    const tierEntries = Object.entries(args.rates.tiers ?? {}) as [JunkVolumeTierCode, number][];
    for (const [tier, cents] of tierEntries) {
      const floor = minimumAcceptablePriceCents({ tier, serviceLevel: "FULL_SERVICE", policy });
      if (cents < floor) throw new RecommendationNotApprovedError(`Legacy ${tier} price $${(cents / 100).toFixed(2)} is below the current floor $${(floor / 100).toFixed(2)}.`);
    }

    const rule = await lockPricingRule(tx, args.marketCode);
    const nextTable = applyLegacyFullServiceRates(parseJunkPriceTableOverride(rule.junkPriceTable), args.rates); // throws on empty / non-positive
    await tx.pricingRule.update({ where: { id: rule.id }, data: { junkPriceTable: nextTable as Prisma.InputJsonValue, active: true } });

    const approvedAt = new Date();
    const approvedTiers = tierEntries.map(([t]) => t);
    const approvedItems = (Object.keys(args.rates.items ?? {}));
    await tx.auditLog.create({
      data: {
        actorId: args.actingUserId, action: "JUNK_LEGACY_PRICING_APPROVED",
        entityType: "PricingRule", entityId: rule.id,
        details: {
          marketCode: args.marketCode, actorRole: args.actingRole, authorizationDecision: "AUTHORIZED",
          serviceLevel: "FULL_SERVICE", approvedTiersCents: args.rates.tiers ?? {}, approvedItemsCents: args.rates.items ?? {},
          policyApprovedAt: policy.carlApprovedAt?.toISOString() ?? null, approvedAt: approvedAt.toISOString(),
        },
      },
    });
    return { marketCode: args.marketCode, pricingRuleId: rule.id, approvedTiers, approvedItems, approvedAt: approvedAt.toISOString() };
  });
}
