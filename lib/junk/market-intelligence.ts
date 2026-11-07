import {
  JUNK_VOLUME_TIERS,
  JUNK_TIER_INFO,
  type JunkVolumeTierCode,
  type JunkSpecialItemCode,
  type JunkServiceLevelCode,
} from "@/lib/junk/pricing";
import {
  estimateDisposalCents,
  planJunkCrew,
  quoteJunkAllocation,
  type JunkAllocationPolicy,
} from "@/lib/junk/allocation";

// ---------------------------------------------------------------------------
// Market Pricing Intelligence — engine (Phase 1, 7 November 2026)
//
// Pure functions, integer cents, no database access. This is an ENHANCEMENT
// layer on Model B: it reuses lib/junk/allocation.ts for the cost floor so the
// floor is provably the same math that actually bills, and it never introduces
// a second pricing or payment engine.
//
// It produces RECOMMENDATIONS for admin review. It does NOT set live prices:
// the authoritative customer price is still the owner-approved PricingRule read
// by resolveJunkMarketPricing(). Nothing here bills, reimburses or refunds.
//
// Directive rules enforced here:
//   §3  Compare only equivalent services. Curbside/economy pricing never
//       benchmarks a full-service in-home job, and vice versa.
//   §4  Competitive target ≈ 3–7% below a valid comparable benchmark, but only
//       when the required financial floor is maintained.
//   §92 When the competitive target falls below the floor, REJECT the discount
//       rather than underpay workers or cut the platform's approved share.
//   §94 Missing/stale data with a valid approved rate → use the approved rate;
//       missing costs or approval → manual-review / quote-unavailable.
//  §116 Never double-count disposal: a competitor rate that already includes
//       labor+disposal is compared to our all-inclusive price directly.
// ---------------------------------------------------------------------------

export type { JunkServiceLevelCode };

/** Owner-approved competitive-discount band (directive §4). 3%–7%, in basis points. */
export const DEFAULT_DISCOUNT_MIN_BPS = 300;
export const DEFAULT_DISCOUNT_MAX_BPS = 700;

export class MarketIntelligenceError extends Error {}

// ---------------------------------------------------------------------------
// Cost floor — the minimum economically acceptable all-inclusive price
// ---------------------------------------------------------------------------

/**
 * The canonical minimum crew for a service level, used to compute a per-tier
 * floor. ECONOMY is a solo hauler (0 helpers); FULL_SERVICE carries the policy's
 * included helper(s). The floor is deliberately the *minimum compliant* crew so
 * it is the lowest sustainable price, never an inflated one.
 */
export function canonicalHelperCount(serviceLevel: JunkServiceLevelCode, policy: Pick<JunkAllocationPolicy, "includedHelperCount">): number {
  return serviceLevel === "ECONOMY" ? 0 : Math.max(0, policy.includedHelperCount);
}

/**
 * Minimum economically acceptable price for a (tier, serviceLevel), derived by
 * reusing the Model B floor repricing in quoteJunkAllocation: price a zero base
 * and let the engine lift it to exactly cover the platform fee, the crew's pay,
 * the internal disposal estimate, the truck allowance and the hauler floor.
 *
 * Because this calls the very function that prices live quotes, the floor can
 * never drift from what actually bills (acceptance test #4).
 */
export function minimumAcceptablePriceCents(input: {
  tier: JunkVolumeTierCode;
  serviceLevel: JunkServiceLevelCode;
  policy: JunkAllocationPolicy;
  specialItems?: JunkSpecialItemCode[];
}): number {
  const tierIndex = JUNK_VOLUME_TIERS.indexOf(input.tier);
  if (tierIndex < 0) throw new MarketIntelligenceError(`Unknown volume tier: ${input.tier}.`);
  const helperCount = canonicalHelperCount(input.serviceLevel, input.policy);
  const estimatedHours = JUNK_TIER_INFO[input.tier].baseHours;
  const crew = planJunkCrew({ helperCount, estimatedHours }, input.policy);
  const disposalEstimateCents = estimateDisposalCents(
    { sizeRank: tierIndex, specialItems: input.specialItems ?? [] },
    input.policy,
  );
  const floor = quoteJunkAllocation({
    basePriceCents: 0,
    disposalEstimateCents,
    crew,
    bookingProtectionCents: 0,
    policy: input.policy,
  });
  return floor.allInCents;
}

// ---------------------------------------------------------------------------
// Competitor benchmark normalization
// ---------------------------------------------------------------------------

export type CompetitorServiceType = "CURBSIDE" | "FULL_SERVICE" | "SPECIALIZED";
export type CompetitorPricingBasis = "ITEM" | "VOLUME" | "TRUCKLOAD" | "HOURLY";
export type BenchmarkConfidence = "HIGH" | "MEDIUM" | "LOW";

/** A competitor observation as stored (the fields the engine needs). */
export type CompetitorObservationInput = {
  id?: string;
  competitor: string;
  observedAt: Date;
  serviceType: CompetitorServiceType;
  pricingBasis: CompetitorPricingBasis;
  comparableTier?: string | null;
  includesLabor: boolean;
  includesDisposal: boolean;
  includesStairs?: boolean;
  advertisedPriceCents: number;
  minimumChargeCents?: number | null;
  additionalItemCents?: number | null;
  confidence: BenchmarkConfidence;
  staleAfterDays: number;
};

export type NormalizedBenchmark = {
  observationId?: string;
  competitor: string;
  comparablePriceCents: number;
  confidence: BenchmarkConfidence;
  observedAt: Date;
};

/** Maps a competitor service shape to our service level; SPECIALIZED never maps. */
export function competitorServiceLevel(serviceType: CompetitorServiceType): JunkServiceLevelCode | null {
  if (serviceType === "CURBSIDE") return "ECONOMY";
  if (serviceType === "FULL_SERVICE") return "FULL_SERVICE";
  return null; // SPECIALIZED — never a general benchmark
}

export function isFresh(observation: Pick<CompetitorObservationInput, "observedAt" | "staleAfterDays">, asOf: Date): boolean {
  const ageDays = (asOf.getTime() - observation.observedAt.getTime()) / 86_400_000;
  return ageDays >= 0 && ageDays <= observation.staleAfterDays;
}

/**
 * Decide whether an observation is a valid, like-for-like benchmark for the
 * requested (tier, serviceLevel) and, if so, the comparable all-inclusive price.
 *
 * Returns { ok: false, reason } when the observation is not comparable, so the
 * caller can audit WHY a data point was excluded (never silently dropped).
 */
export function normalizeObservation(
  observation: CompetitorObservationInput,
  target: { tier: JunkVolumeTierCode; serviceLevel: JunkServiceLevelCode; asOf: Date },
): { ok: true; benchmark: NormalizedBenchmark } | { ok: false; reason: string } {
  // Equivalent services only (directive §3). Curbside/economy never benchmarks
  // a full-service job and vice versa.
  const level = competitorServiceLevel(observation.serviceType);
  if (level === null) return { ok: false, reason: `${observation.competitor}: specialized service is not a general benchmark.` };
  if (level !== target.serviceLevel) {
    return { ok: false, reason: `${observation.competitor}: ${observation.serviceType} maps to ${level}, not the requested ${target.serviceLevel}.` };
  }
  // Must be an all-inclusive comparable: our price includes labor + disposal, so
  // a competitor rate that excludes either is not directly comparable (and we do
  // NOT stack disposal onto it — §116).
  if (!observation.includesLabor || !observation.includesDisposal) {
    return { ok: false, reason: `${observation.competitor}: price excludes labor or disposal; not comparable to an all-inclusive price.` };
  }
  // Confidence + freshness gates.
  if (observation.confidence === "LOW") return { ok: false, reason: `${observation.competitor}: LOW confidence (e.g. national estimate), excluded from benchmarking.` };
  if (!isFresh(observation, target.asOf)) return { ok: false, reason: `${observation.competitor}: observation is stale (older than ${observation.staleAfterDays} days).` };

  // Pricing-basis comparability.
  let comparablePriceCents: number;
  if (observation.pricingBasis === "VOLUME" || observation.pricingBasis === "TRUCKLOAD") {
    if (!observation.comparableTier || observation.comparableTier !== target.tier) {
      return { ok: false, reason: `${observation.competitor}: volume tier "${observation.comparableTier ?? "?"}" does not match requested ${target.tier}.` };
    }
    comparablePriceCents = observation.advertisedPriceCents;
  } else if (observation.pricingBasis === "ITEM") {
    // An item price is only comparable to a single-item job (Phase 1); multi-item
    // bundles are not auto-benchmarked.
    if (target.tier !== "SINGLE_ITEM") {
      return { ok: false, reason: `${observation.competitor}: per-item price is only comparable to a single-item job, not ${target.tier}.` };
    }
    comparablePriceCents = observation.advertisedPriceCents;
  } else {
    // HOURLY is not comparable to a flat all-inclusive tier price in Phase 1.
    return { ok: false, reason: `${observation.competitor}: hourly pricing is not comparable to a flat tier price.` };
  }

  if (!Number.isInteger(comparablePriceCents) || comparablePriceCents <= 0) {
    return { ok: false, reason: `${observation.competitor}: non-positive comparable price.` };
  }
  return {
    ok: true,
    benchmark: {
      observationId: observation.id,
      competitor: observation.competitor,
      comparablePriceCents,
      confidence: observation.confidence,
      observedAt: observation.observedAt,
    },
  };
}

// ---------------------------------------------------------------------------
// Recommendation decision
// ---------------------------------------------------------------------------

export type RecommendationStatus =
  | "RECOMMENDED" // competitive target within the 3–7% band, at or above floor
  | "FLOOR_CONSTRAINED" // undercut feasible but smaller than the 3% minimum, held at floor
  | "FLOOR_HELD" // competitor sits below our cost floor; discount rejected (directive §92)
  | "USE_APPROVED" // no valid benchmark; the existing owner-approved rate is retained
  | "MANUAL_REVIEW" // no benchmark and no approved rate; needs owner input
  | "NO_FLOOR"; // essential cost inputs missing; cannot compute a floor

export type MarketPriceDecision = {
  status: RecommendationStatus;
  /** The proposed all-inclusive price (cents). Null only for MANUAL_REVIEW / NO_FLOOR. */
  recommendedPriceCents: number | null;
  floorPriceCents: number | null;
  competitiveTargetCents: number | null;
  discountBps: number | null;
  benchmarkPriceCents: number | null;
  benchmarkCompetitor: string | null;
  benchmarkObservationId: string | null;
  rationale: string;
  /** Every observation considered, with why it was used or excluded (audit). */
  excluded: string[];
};

/** Rounds a target price UP to the nearest whole dollar so it never dips below the floor and reads cleanly. */
function roundUpDollar(cents: number): number {
  return Math.ceil(cents / 100) * 100;
}

/**
 * Decide the recommended price for one (market, tier, serviceLevel).
 *
 * `benchmarks` are the already-normalized, valid comparable prices. The engine
 * anchors on the LOWEST valid comparable (the price to actually beat) and aims
 * 3–7% below it, but never below the cost floor.
 */
export function decideMarketPrice(input: {
  floorPriceCents: number | null;
  approvedRateCents: number | null;
  benchmarks: NormalizedBenchmark[];
  excluded?: string[];
  discountMinBps?: number;
  discountMaxBps?: number;
}): MarketPriceDecision {
  const excluded = input.excluded ?? [];
  const discountMinBps = input.discountMinBps ?? DEFAULT_DISCOUNT_MIN_BPS;
  const discountMaxBps = input.discountMaxBps ?? DEFAULT_DISCOUNT_MAX_BPS;

  if (input.floorPriceCents == null) {
    return {
      status: "NO_FLOOR", recommendedPriceCents: null, floorPriceCents: null,
      competitiveTargetCents: null, discountBps: null, benchmarkPriceCents: null,
      benchmarkCompetitor: null, benchmarkObservationId: null,
      rationale: "Essential operating costs are missing, so a cost floor cannot be computed. Manual review required.",
      excluded,
    };
  }
  const floor = input.floorPriceCents;

  // Pick the lowest valid comparable as the price to beat.
  const anchor = input.benchmarks.length > 0
    ? input.benchmarks.reduce((lo, b) => (b.comparablePriceCents < lo.comparablePriceCents ? b : lo))
    : null;

  if (!anchor) {
    // No valid benchmark. Retain the owner-approved rate if there is one and it
    // is sustainable; otherwise this (market, tier, level) needs owner input.
    if (input.approvedRateCents == null) {
      return {
        status: "MANUAL_REVIEW", recommendedPriceCents: null, floorPriceCents: floor,
        competitiveTargetCents: null, discountBps: null, benchmarkPriceCents: null,
        benchmarkCompetitor: null, benchmarkObservationId: null,
        rationale: "No valid competitor benchmark and no owner-approved rate for this tier/service level. Manual review required.",
        excluded,
      };
    }
    const held = Math.max(input.approvedRateCents, floor);
    return {
      status: held > input.approvedRateCents ? "FLOOR_HELD" : "USE_APPROVED",
      recommendedPriceCents: held, floorPriceCents: floor,
      competitiveTargetCents: null, discountBps: null, benchmarkPriceCents: null,
      benchmarkCompetitor: null, benchmarkObservationId: null,
      rationale: held > input.approvedRateCents
        ? `No valid benchmark; the approved rate ($${(input.approvedRateCents / 100).toFixed(2)}) is below the cost floor, so the floor is proposed instead.`
        : "No valid benchmark; retaining the owner-approved rate.",
      excluded,
    };
  }

  const benchmark = anchor.comparablePriceCents;
  const targetAtMax = Math.round(benchmark * (1 - discountMaxBps / 10000)); // deepest sustainable undercut (e.g. 7% below)
  const targetAtMin = Math.round(benchmark * (1 - discountMinBps / 10000)); // shallowest in-band undercut (e.g. 3% below)

  const base = {
    floorPriceCents: floor,
    benchmarkPriceCents: benchmark,
    benchmarkCompetitor: anchor.competitor,
    benchmarkObservationId: anchor.observationId ?? null,
    excluded,
  };

  // Competitor sits at or below our cost floor → reject the discount (§92).
  if (benchmark <= floor) {
    const held = Math.max(input.approvedRateCents ?? floor, floor);
    return {
      ...base, status: "FLOOR_HELD",
      recommendedPriceCents: held,
      competitiveTargetCents: targetAtMax,
      discountBps: null,
      rationale: `${anchor.competitor}'s comparable price ($${(benchmark / 100).toFixed(2)}) is at or below our cost floor ($${(floor / 100).toFixed(2)}). Discount rejected; holding at $${(held / 100).toFixed(2)} to protect worker pay and the platform's approved share.`,
    };
  }

  // Deepest in-band undercut (7% below) is sustainable → take it.
  if (targetAtMax >= floor) {
    const price = Math.max(roundUpDollar(targetAtMax), floor);
    return {
      ...base, status: "RECOMMENDED",
      recommendedPriceCents: price,
      competitiveTargetCents: targetAtMax,
      discountBps: discountMaxBps,
      rationale: `${discountMaxBps / 100}% below ${anchor.competitor}'s $${(benchmark / 100).toFixed(2)}, at $${(price / 100).toFixed(2)}, which clears the $${(floor / 100).toFixed(2)} floor.`,
    };
  }

  // Floor lands inside the 3–7% band → deepest sustainable discount is the floor.
  if (floor <= targetAtMin) {
    const impliedBps = Math.round((1 - floor / benchmark) * 10000);
    return {
      ...base, status: "RECOMMENDED",
      recommendedPriceCents: floor,
      competitiveTargetCents: targetAtMax,
      discountBps: impliedBps,
      rationale: `A full ${discountMaxBps / 100}% undercut would dip below the floor; proposing the floor $${(floor / 100).toFixed(2)} (≈${(impliedBps / 100).toFixed(1)}% below ${anchor.competitor}), the deepest sustainable discount.`,
    };
  }

  // Floor is less than the 3% minimum below the benchmark: only a sub-band
  // undercut is possible. Hold at the floor and flag it as constrained.
  const impliedBps = Math.round((1 - floor / benchmark) * 10000);
  return {
    ...base, status: "FLOOR_CONSTRAINED",
    recommendedPriceCents: floor,
    competitiveTargetCents: targetAtMin,
    discountBps: impliedBps,
    rationale: `The cost floor $${(floor / 100).toFixed(2)} allows only a ${(impliedBps / 100).toFixed(1)}% undercut of ${anchor.competitor}'s $${(benchmark / 100).toFixed(2)}, below the ${discountMinBps / 100}% target. Holding at the floor.`,
  };
}

/**
 * End-to-end recommendation for one (tier, serviceLevel): compute the floor,
 * normalize observations (recording exclusions), and decide. A convenience
 * wrapper over minimumAcceptablePriceCents + normalizeObservation + decideMarketPrice.
 */
export function recommendMarketPrice(input: {
  tier: JunkVolumeTierCode;
  serviceLevel: JunkServiceLevelCode;
  policy: JunkAllocationPolicy;
  approvedRateCents: number | null;
  observations: CompetitorObservationInput[];
  asOf?: Date;
  discountMinBps?: number;
  discountMaxBps?: number;
}): MarketPriceDecision {
  const asOf = input.asOf ?? new Date();
  let floorPriceCents: number | null;
  try {
    floorPriceCents = minimumAcceptablePriceCents({ tier: input.tier, serviceLevel: input.serviceLevel, policy: input.policy });
  } catch {
    floorPriceCents = null;
  }
  const benchmarks: NormalizedBenchmark[] = [];
  const excluded: string[] = [];
  for (const obs of input.observations) {
    const n = normalizeObservation(obs, { tier: input.tier, serviceLevel: input.serviceLevel, asOf });
    if (n.ok) benchmarks.push(n.benchmark);
    else excluded.push(n.reason);
  }
  return decideMarketPrice({
    floorPriceCents,
    approvedRateCents: input.approvedRateCents,
    benchmarks,
    excluded,
    discountMinBps: input.discountMinBps,
    discountMaxBps: input.discountMaxBps,
  });
}
