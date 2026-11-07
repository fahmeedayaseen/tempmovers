import { describe, expect, it } from "vitest";
import { DEFAULT_JUNK_ALLOCATION_POLICY, type JunkAllocationPolicy } from "@/lib/junk/allocation";
import {
  minimumAcceptablePriceCents,
  canonicalHelperCount,
  normalizeObservation,
  decideMarketPrice,
  recommendMarketPrice,
  isFresh,
  competitorServiceLevel,
  type CompetitorObservationInput,
  type NormalizedBenchmark,
} from "@/lib/junk/market-intelligence";
import {
  calculateJunkQuote, junkEconomyEligible, DEFAULT_JUNK_PRICE_TABLE, type JunkQuoteInput,
} from "@/lib/junk/pricing";
import { decideJunkAvailability } from "@/lib/junk/market-pricing";
import { COMPETITOR_OBSERVATIONS } from "@/lib/junk/seed-competitors";

// Market Pricing Intelligence — Phase 1 (7 Nov 2026). The engine recommends; it
// never bills. The cost floor is the real Model B math (reused from
// lib/junk/allocation.ts), competitor benchmarks are compared like-for-like,
// the 3–7% undercut applies only above the floor, and an unapproved market is
// routed to MANUAL_REVIEW rather than quoted from example amounts.

const policy: JunkAllocationPolicy = DEFAULT_JUNK_ALLOCATION_POLICY;
const asOf = new Date("2026-11-07T00:00:00.000Z");

// Base quote input helper (VOLUME).
function volInput(over: Partial<JunkQuoteInput> = {}): JunkQuoteInput {
  return {
    table: DEFAULT_JUNK_PRICE_TABLE,
    takeRatePercent: 30,
    helperSharePercent: 25,
    bookingProtectionCents: 0,
    pricingMode: "VOLUME",
    volumeTier: "SINGLE_ITEM",
    items: null,
    specialItems: [],
    itemLocation: "CURBSIDE",
    hasHeavyItems: false,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Cost floor (acceptance #4) — reuses the Model B engine, so it never drifts.
// ---------------------------------------------------------------------------
describe("minimum acceptable price (cost floor)", () => {
  it("ECONOMY single item (solo) floors at $92.86", () => {
    expect(minimumAcceptablePriceCents({ tier: "SINGLE_ITEM", serviceLevel: "ECONOMY", policy })).toBe(9286);
  });

  it("FULL_SERVICE single item (1 included helper, 2h min) floors at $178.57 — far above the economy floor", () => {
    expect(minimumAcceptablePriceCents({ tier: "SINGLE_ITEM", serviceLevel: "FULL_SERVICE", policy })).toBe(17857);
  });

  it("FULL_SERVICE half truck floors at $271.43", () => {
    expect(minimumAcceptablePriceCents({ tier: "HALF", serviceLevel: "FULL_SERVICE", policy })).toBe(27143);
  });

  it("canonical crew: ECONOMY is solo (0), FULL_SERVICE carries the included helper(s)", () => {
    expect(canonicalHelperCount("ECONOMY", policy)).toBe(0);
    expect(canonicalHelperCount("FULL_SERVICE", policy)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Competitor comparability (acceptance #3) — like services only.
// ---------------------------------------------------------------------------
describe("competitor normalization", () => {
  const loadUpCurb: CompetitorObservationInput = {
    competitor: "LoadUp", observedAt: new Date("2026-11-06T00:00:00.000Z"),
    serviceType: "CURBSIDE", pricingBasis: "ITEM", includesLabor: true, includesDisposal: true,
    advertisedPriceCents: 7900, confidence: "MEDIUM", staleAfterDays: 30,
  };

  it("maps service shapes; SPECIALIZED is never a general benchmark", () => {
    expect(competitorServiceLevel("CURBSIDE")).toBe("ECONOMY");
    expect(competitorServiceLevel("FULL_SERVICE")).toBe("FULL_SERVICE");
    expect(competitorServiceLevel("SPECIALIZED")).toBeNull();
  });

  it("a curbside/economy price never benchmarks a full-service job (directive §3)", () => {
    const r = normalizeObservation(loadUpCurb, { tier: "SINGLE_ITEM", serviceLevel: "FULL_SERVICE", asOf });
    expect(r.ok).toBe(false);
  });

  it("a comparable curbside single-item price is accepted for an ECONOMY single-item job", () => {
    const r = normalizeObservation(loadUpCurb, { tier: "SINGLE_ITEM", serviceLevel: "ECONOMY", asOf });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.benchmark.comparablePriceCents).toBe(7900);
  });

  it("excludes LOW-confidence (national) observations and price that omits labor/disposal", () => {
    expect(normalizeObservation({ ...loadUpCurb, confidence: "LOW" }, { tier: "SINGLE_ITEM", serviceLevel: "ECONOMY", asOf }).ok).toBe(false);
    expect(normalizeObservation({ ...loadUpCurb, includesDisposal: false }, { tier: "SINGLE_ITEM", serviceLevel: "ECONOMY", asOf }).ok).toBe(false);
  });

  it("excludes stale observations", () => {
    const stale = { ...loadUpCurb, observedAt: new Date("2026-01-01T00:00:00.000Z") };
    expect(isFresh(stale, asOf)).toBe(false);
    expect(normalizeObservation(stale, { tier: "SINGLE_ITEM", serviceLevel: "ECONOMY", asOf }).ok).toBe(false);
  });

  it("a volume benchmark must match the requested tier", () => {
    const vol: CompetitorObservationInput = {
      competitor: "Junk King", observedAt: new Date("2026-11-06T00:00:00.000Z"),
      serviceType: "FULL_SERVICE", pricingBasis: "VOLUME", comparableTier: "HALF",
      includesLabor: true, includesDisposal: true, advertisedPriceCents: 40000, confidence: "MEDIUM", staleAfterDays: 30,
    };
    expect(normalizeObservation(vol, { tier: "FULL", serviceLevel: "FULL_SERVICE", asOf }).ok).toBe(false);
    expect(normalizeObservation(vol, { tier: "HALF", serviceLevel: "FULL_SERVICE", asOf }).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Pricing decision (acceptance #4 unprofitable + profitable scenarios).
// ---------------------------------------------------------------------------
describe("market price decision", () => {
  const b = (cents: number, competitor = "X"): NormalizedBenchmark => ({
    competitor, comparablePriceCents: cents, confidence: "MEDIUM", observedAt: asOf,
  });

  it("UNPROFITABLE: competitor below the cost floor → discount rejected, floor held (directive §92)", () => {
    const floor = minimumAcceptablePriceCents({ tier: "SINGLE_ITEM", serviceLevel: "ECONOMY", policy }); // 9286
    const d = decideMarketPrice({ floorPriceCents: floor, approvedRateCents: 11900, benchmarks: [b(7900, "LoadUp")] });
    expect(d.status).toBe("FLOOR_HELD");
    expect(d.recommendedPriceCents).toBe(11900); // never below floor, holds approved rate
    expect(d.benchmarkPriceCents).toBe(7900);
    expect(d.recommendedPriceCents!).toBeGreaterThanOrEqual(floor);
  });

  it("PROFITABLE: 7% below a comparable benchmark that clears the floor → RECOMMENDED", () => {
    const floor = minimumAcceptablePriceCents({ tier: "HALF", serviceLevel: "FULL_SERVICE", policy }); // 27143
    const d = decideMarketPrice({ floorPriceCents: floor, approvedRateCents: 42500, benchmarks: [b(40000, "1-800")] });
    expect(d.status).toBe("RECOMMENDED");
    expect(d.discountBps).toBe(700);
    expect(d.recommendedPriceCents).toBe(37200); // 7% below $400, rounded up to the dollar
    expect(d.recommendedPriceCents!).toBeGreaterThanOrEqual(floor);
  });

  it("recommended price is NEVER below the floor, even when the target would be", () => {
    // Floor sits between the 3% and 7% targets → hold at the floor, still RECOMMENDED.
    const d = decideMarketPrice({ floorPriceCents: 9000, approvedRateCents: null, benchmarks: [b(9500)] });
    expect(d.recommendedPriceCents).toBe(9000);
    expect(d.recommendedPriceCents!).toBeGreaterThanOrEqual(9000);
  });

  it("no benchmark + no approved rate → MANUAL_REVIEW (never invents a price)", () => {
    const d = decideMarketPrice({ floorPriceCents: 9286, approvedRateCents: null, benchmarks: [] });
    expect(d.status).toBe("MANUAL_REVIEW");
    expect(d.recommendedPriceCents).toBeNull();
  });

  it("no benchmark + approved rate above floor → USE_APPROVED", () => {
    const d = decideMarketPrice({ floorPriceCents: 9286, approvedRateCents: 12900, benchmarks: [] });
    expect(d.status).toBe("USE_APPROVED");
    expect(d.recommendedPriceCents).toBe(12900);
  });

  it("missing cost inputs → NO_FLOOR (manual review)", () => {
    const d = decideMarketPrice({ floorPriceCents: null, approvedRateCents: 12900, benchmarks: [b(40000)] });
    expect(d.status).toBe("NO_FLOOR");
    expect(d.recommendedPriceCents).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// End-to-end over the seeded data (honest: only LoadUp local is benchmarkable).
// ---------------------------------------------------------------------------
describe("recommendMarketPrice over seeded observations", () => {
  const indy = COMPETITOR_OBSERVATIONS.filter((o) => o.marketCode === "INDY");

  it("INDY economy single item: LoadUp's verified local $79 is below floor → FLOOR_HELD", () => {
    const d = recommendMarketPrice({
      tier: "SINGLE_ITEM", serviceLevel: "ECONOMY", policy, approvedRateCents: 12900, observations: indy, asOf,
    });
    expect(d.status).toBe("FLOOR_HELD");
    expect(d.benchmarkCompetitor).toBe("LoadUp");
    // the non-economy rows were excluded from this economy benchmark
    expect(d.excluded.length).toBeGreaterThan(0);
  });

  it("INDY full-service half truck: only national (LOW) data → excluded, no benchmark, approved rate retained", () => {
    const d = recommendMarketPrice({
      tier: "HALF", serviceLevel: "FULL_SERVICE", policy, approvedRateCents: 42500, observations: indy, asOf,
    });
    expect(["USE_APPROVED", "MANUAL_REVIEW"]).toContain(d.status);
    expect(d.benchmarkPriceCents).toBeNull();
    // the national full-service figures were explicitly excluded as LOW confidence
    expect(d.excluded.some((r) => /LOW confidence|national/i.test(r))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Service-level eligibility (directive §6) — no silent downgrade.
// ---------------------------------------------------------------------------
describe("service-level eligibility", () => {
  it("curbside, light, small job is economy-eligible", () => {
    expect(junkEconomyEligible(volInput({ volumeTier: "QUARTER" }))).toBe(true);
  });

  it("in-home, heavy, stairs, or large jobs are NOT economy-eligible", () => {
    expect(junkEconomyEligible(volInput({ itemLocation: "UPSTAIRS" }))).toBe(false);
    expect(junkEconomyEligible(volInput({ hasHeavyItems: true }))).toBe(false);
    expect(junkEconomyEligible(volInput({ volumeTier: "FULL" }))).toBe(false);
  });

  it("booking ECONOMY on an ineligible job throws, never silently downgrades to a solo price", () => {
    expect(() => calculateJunkQuote(volInput({ volumeTier: "FULL", serviceLevel: "ECONOMY" }))).toThrow();
  });

  it("ECONOMY eligible job prices as a solo crew (0 helpers); FULL_SERVICE keeps the normal crew", () => {
    const eco = calculateJunkQuote(volInput({ volumeTier: "QUARTER", itemLocation: "CURBSIDE", serviceLevel: "ECONOMY" }));
    expect(eco.helpersRequired).toBe(0);
    expect(eco.serviceLevel).toBe("ECONOMY");
    const full = calculateJunkQuote(volInput({ volumeTier: "QUARTER", itemLocation: "INSIDE_GROUND", serviceLevel: "FULL_SERVICE" }));
    expect(full.serviceLevel).toBe("FULL_SERVICE");
  });

  it("default service level is FULL_SERVICE (existing bookings price unchanged)", () => {
    const q = calculateJunkQuote(volInput({ volumeTier: "HALF" }));
    expect(q.serviceLevel).toBe("FULL_SERVICE");
  });
});

// ---------------------------------------------------------------------------
// Availability gate (acceptance #9, #10) — no quoting from unapproved amounts.
// ---------------------------------------------------------------------------
describe("junk quote availability", () => {
  it("a ZIP no market serves is UNAVAILABLE", () => {
    expect(decideJunkAvailability({ marketServesZip: false, policyApproved: true, hasActivePriceRule: true }).state).toBe("UNAVAILABLE");
  });

  it("an unapproved market (no owner-approved policy) is MANUAL_REVIEW, never a quote", () => {
    expect(decideJunkAvailability({ marketServesZip: true, policyApproved: false, hasActivePriceRule: true }).state).toBe("MANUAL_REVIEW");
    expect(decideJunkAvailability({ marketServesZip: true, policyApproved: true, hasActivePriceRule: false }).state).toBe("MANUAL_REVIEW");
  });

  it("approved policy + active price source → AVAILABLE", () => {
    expect(decideJunkAvailability({ marketServesZip: true, policyApproved: true, hasActivePriceRule: true }).state).toBe("AVAILABLE");
  });
});
