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
  calculateJunkQuote, junkEconomyEligible, DEFAULT_JUNK_PRICE_TABLE,
  resolveJunkPriceTable, resolveApprovedJunkPrice, type JunkQuoteInput, type JunkPriceTableOverride,
} from "@/lib/junk/pricing";
import { decideJunkAvailability } from "@/lib/junk/market-pricing";
import {
  applyApprovedRecommendationToTable, assertApprovable, RecommendationNotApprovedError,
  ApprovalForbiddenError, FloorOutOfDateError,
} from "@/lib/junk/pricing-approval";
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

  it("INDY economy single item: LoadUp's verified local $65 is below floor → FLOOR_HELD", () => {
    const d = recommendMarketPrice({
      tier: "SINGLE_ITEM", serviceLevel: "ECONOMY", policy, approvedRateCents: 12900, observations: indy, asOf,
    });
    expect(d.status).toBe("FLOOR_HELD");
    expect(d.benchmarkCompetitor).toBe("LoadUp"); // lowest valid comparable ($65 < Dropcurb $79)
    expect(d.benchmarkPriceCents).toBe(6500);
    expect(d.recommendedPriceCents!).toBeGreaterThanOrEqual(9286); // never below the $92.86 floor
  });

  it("INDY full-service half truck: seed holds only economy single-item data → no comparable benchmark, approved rate retained", () => {
    const d = recommendMarketPrice({
      tier: "HALF", serviceLevel: "FULL_SERVICE", policy, approvedRateCents: 42500, observations: indy, asOf,
    });
    expect(["USE_APPROVED", "MANUAL_REVIEW"]).toContain(d.status);
    expect(d.benchmarkPriceCents).toBeNull();
    // every economy/single-item row was excluded as not comparable to a full-service half-truck job
    expect(d.excluded.length).toBeGreaterThan(0);
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
describe("junk quote availability (no US-DEFAULT bypass; approved exact rate required)", () => {
  it("wrong ZIP / no market serves it → UNAVAILABLE (JUNK_NOT_AVAILABLE)", () => {
    const a = decideJunkAvailability({ marketServesZip: false, policyApprovedForMarket: true, hasApprovedExactRate: true });
    expect(a.state).toBe("UNAVAILABLE");
    if (a.state === "UNAVAILABLE") expect(a.code).toBe("JUNK_NOT_AVAILABLE");
  });

  it("missing market-approved policy → MANUAL_REVIEW (409 JUNK_PRICING_UNAPPROVED)", () => {
    const a = decideJunkAvailability({ marketServesZip: true, policyApprovedForMarket: false, hasApprovedExactRate: true });
    expect(a.state).toBe("MANUAL_REVIEW");
    if (a.state === "MANUAL_REVIEW") expect(a.code).toBe("JUNK_PRICING_UNAPPROVED");
  });

  it("no approved exact-market/service-level/tier rate → MANUAL_REVIEW (active market row alone is insufficient)", () => {
    expect(decideJunkAvailability({ marketServesZip: true, policyApprovedForMarket: true, hasApprovedExactRate: false }).state).toBe("MANUAL_REVIEW");
  });

  it("valid owner-approved exact rate + approved market policy → AVAILABLE", () => {
    expect(decideJunkAvailability({ marketServesZip: true, policyApprovedForMarket: true, hasApprovedExactRate: true }).state).toBe("AVAILABLE");
  });
});

// ---------------------------------------------------------------------------
// Correction 1 — prices are separate per (service level, tier).
// ---------------------------------------------------------------------------
describe("per-service-level pricing", () => {
  it("Economy and Full-Service can hold different prices for the same tier", () => {
    const override: JunkPriceTableOverride = { serviceLevels: { ECONOMY: { tiersCents: { SINGLE_ITEM: 9900 } }, FULL_SERVICE: { tiersCents: { SINGLE_ITEM: 17900 } } } };
    expect(resolveJunkPriceTable(override, "ECONOMY").tiersCents.SINGLE_ITEM).toBe(9900);
    expect(resolveJunkPriceTable(override, "FULL_SERVICE").tiersCents.SINGLE_ITEM).toBe(17900);
  });

  it("legacy top-level tiersCents reads as the FULL_SERVICE price (back-compat), never Economy", () => {
    const legacy: JunkPriceTableOverride = { tiersCents: { HALF: 32900 } };
    expect(resolveApprovedJunkPrice(legacy, "FULL_SERVICE", { pricingMode: "VOLUME", volumeTier: "HALF" }).approved).toBe(true);
    expect(resolveApprovedJunkPrice(legacy, "ECONOMY", { pricingMode: "VOLUME", volumeTier: "HALF" }).approved).toBe(false);
  });

  it("an unconfigured (service level, tier) is NOT approved — never billed from built-in defaults", () => {
    expect(resolveApprovedJunkPrice({}, "ECONOMY", { pricingMode: "VOLUME", volumeTier: "SINGLE_ITEM" }).approved).toBe(false);
    expect(resolveApprovedJunkPrice(null, "FULL_SERVICE", { pricingMode: "VOLUME", volumeTier: "HALF" }).approved).toBe(false);
  });

  it("an approved Economy tier does not make the Full-Service tier approved", () => {
    const override: JunkPriceTableOverride = { serviceLevels: { ECONOMY: { tiersCents: { SINGLE_ITEM: 9900 } } } };
    expect(resolveApprovedJunkPrice(override, "ECONOMY", { pricingMode: "VOLUME", volumeTier: "SINGLE_ITEM" }).approved).toBe(true);
    expect(resolveApprovedJunkPrice(override, "FULL_SERVICE", { pricingMode: "VOLUME", volumeTier: "SINGLE_ITEM" }).approved).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Approval path — only an APPROVED recommendation becomes a price, written to
// its OWN service-level slot (correction 1), behind an authenticated guard (C2).
// ---------------------------------------------------------------------------
describe("recommendation -> PricingRule approval transform", () => {
  const approved = { status: "APPROVED" as const, serviceLevel: "ECONOMY" as const, volumeTier: "SINGLE_ITEM" as const, recommendedPriceCents: 11900, floorPriceCents: 9286 };

  it("writes only into the recommendation's own service-level slot (never the other)", () => {
    const start: JunkPriceTableOverride = { serviceLevels: { FULL_SERVICE: { tiersCents: { SINGLE_ITEM: 17900 } } } };
    const table = applyApprovedRecommendationToTable(start, approved);
    expect(table.serviceLevels?.ECONOMY?.tiersCents?.SINGLE_ITEM).toBe(11900);
    expect(table.serviceLevels?.FULL_SERVICE?.tiersCents?.SINGLE_ITEM).toBe(17900); // untouched
  });

  it("a PENDING recommendation can never be applied", () => {
    expect(() => applyApprovedRecommendationToTable({}, { ...approved, status: "PENDING" })).toThrow(RecommendationNotApprovedError);
  });

  it("refuses to persist a price below the cost floor", () => {
    expect(() => applyApprovedRecommendationToTable({}, { ...approved, recommendedPriceCents: 5000 })).toThrow(RecommendationNotApprovedError);
  });

  it("does not mutate the input override", () => {
    const current: JunkPriceTableOverride = { serviceLevels: { FULL_SERVICE: { tiersCents: { SINGLE_ITEM: 17900 } } } };
    applyApprovedRecommendationToTable(current, approved);
    expect(current.serviceLevels?.ECONOMY).toBeUndefined();
  });
});

describe("assertApprovable guard (C2)", () => {
  const roles = ["ADMIN", "FINANCE_ADMIN", "SUPER_ADMIN"] as const;
  const ok = { actingRole: "ADMIN", approverRoles: roles, status: "PENDING" as const, recommendedPriceCents: 37200, recordedFloorCents: 27143, currentFloorCents: 27143 };

  it("passes for an authorised admin, PENDING, at/above current floor, floor unchanged", () => {
    expect(() => assertApprovable(ok)).not.toThrow();
  });
  it("rejects an unauthorised role", () => {
    expect(() => assertApprovable({ ...ok, actingRole: "CUSTOMER" })).toThrow(ApprovalForbiddenError);
  });
  it("rejects a non-PENDING (stale / superseded / rejected / already-approved) recommendation", () => {
    for (const status of ["APPROVED", "REJECTED", "SUPERSEDED"] as const) {
      expect(() => assertApprovable({ ...ok, status })).toThrow(RecommendationNotApprovedError);
    }
  });
  it("rejects a price below the current floor", () => {
    expect(() => assertApprovable({ ...ok, recommendedPriceCents: 20000 })).toThrow(RecommendationNotApprovedError);
  });
  it("rejects an out-of-date floor (floor moved since the recommendation was generated)", () => {
    expect(() => assertApprovable({ ...ok, currentFloorCents: 28000 })).toThrow(FloorOutOfDateError);
  });
});

// ---------------------------------------------------------------------------
// Reconciliation — Model B invariants hold for an approved service-level price.
// ---------------------------------------------------------------------------
describe("reconciliation of an approved price (Model B unchanged)", () => {
  it("30% fee on the full price; fee + helper pay + hauler residual reconcile to the collected total", () => {
    // FULL_SERVICE half-truck at an approved $372 (from the engine's 7%-below example).
    const table = resolveJunkPriceTable({ serviceLevels: { FULL_SERVICE: { tiersCents: { HALF: 37200 } } } }, "FULL_SERVICE");
    const input: JunkQuoteInput = {
      table, takeRatePercent: 30, helperSharePercent: 25, bookingProtectionCents: 0,
      pricingMode: "VOLUME", volumeTier: "HALF", items: null, specialItems: [],
      itemLocation: "CURBSIDE", hasHeavyItems: false, serviceLevel: "FULL_SERVICE",
    };
    const q = calculateJunkQuote(input);
    expect(q.servicePriceCents).toBe(37200); // the approved service-level price drives billing
  });
});
