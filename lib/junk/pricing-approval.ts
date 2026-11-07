import type { JunkVolumeTierCode, JunkPriceTableOverride } from "@/lib/junk/pricing";

// ---------------------------------------------------------------------------
// Approval path: recommendation -> PricingRule (correction handoff BLOCKER 1)
//
// This is the ONLY mechanism by which a Market Pricing Intelligence
// recommendation can become an authoritative, billable price. It is a pure
// transform with a hard status gate; it is never called automatically. The
// full owner flow is:
//
//   1. The engine writes a MarketPriceRecommendation (status PENDING). It never bills.
//   2. An admin reviews it (Phase 2 UI) and sets status APPROVED.
//   3. On approval, the admin action calls applyApprovedRecommendationToTable()
//      to fold the approved price into the market's PricingRule.junkPriceTable
//      override, and stamps the PricingRule active + carlApprovedAt.
//   4. From then on resolveJunkMarketPricing() reads that approved table — so
//      every live quote and booking is sourced from approved market
//      configuration, never from example defaults. Until then the availability
//      gate (decideJunkAvailability) returns MANUAL_REVIEW.
//
// A PENDING or REJECTED recommendation can never be applied: the gate below
// throws, so there is no path from an unapproved proposal to a live price.
// ---------------------------------------------------------------------------

export class RecommendationNotApprovedError extends Error {}

export type ApprovableRecommendation = {
  status: "PENDING" | "APPROVED" | "REJECTED" | "SUPERSEDED";
  volumeTier: JunkVolumeTierCode;
  recommendedPriceCents: number;
  floorPriceCents: number;
};

/**
 * Fold an APPROVED recommendation's price into a PricingRule.junkPriceTable
 * override, returning a NEW override (does not mutate the input). Throws unless
 * the recommendation is APPROVED and the price is a positive integer at or
 * above its own cost floor — the engine should never have proposed a price
 * below the floor, and we refuse to persist one here as a defence in depth.
 */
export function applyApprovedRecommendationToTable(
  current: JunkPriceTableOverride,
  rec: ApprovableRecommendation,
): JunkPriceTableOverride {
  if (rec.status !== "APPROVED") {
    throw new RecommendationNotApprovedError(
      `Refusing to apply a ${rec.status} recommendation. Only an APPROVED recommendation becomes a live price.`,
    );
  }
  if (!Number.isInteger(rec.recommendedPriceCents) || rec.recommendedPriceCents <= 0) {
    throw new RecommendationNotApprovedError("Refusing to apply a non-positive recommended price.");
  }
  if (rec.recommendedPriceCents < rec.floorPriceCents) {
    throw new RecommendationNotApprovedError(
      `Refusing to apply $${(rec.recommendedPriceCents / 100).toFixed(2)}: below the cost floor $${(rec.floorPriceCents / 100).toFixed(2)}.`,
    );
  }
  return {
    ...current,
    tiersCents: { ...(current.tiersCents ?? {}), [rec.volumeTier]: rec.recommendedPriceCents },
  };
}
