import { describe, it, expect } from "vitest";
import { computeAccessorial, customerChargeFor, platformShareFor, isRateWithinBand, type AccessorialPricingConfig } from "@/lib/accessorials/compute";
import { resolvePriceRow, hasOverlap, isEffectiveAt, type PriceRow } from "@/lib/accessorials/resolver";

const cfg = (o: Partial<AccessorialPricingConfig>): AccessorialPricingConfig => ({
  pricingShape: "FLAT", customerRateCents: 1000, platformShareMode: "FLAT_CENTS", platformShareValue: 0, ...o,
});

describe("computeAccessorial — pricing shapes", () => {
  it("FLAT charges the flat rate", () => {
    expect(computeAccessorial(cfg({ pricingShape: "FLAT", customerRateCents: 15000, platformShareValue: 5000 }), { quantity: 1 }))
      .toEqual({ customerChargeCents: 15000, platformShareCents: 5000, providerShareCents: 10000 });
  });
  it("PER_FLIGHT multiplies by flights", () => {
    expect(customerChargeFor(cfg({ pricingShape: "PER_FLIGHT", customerRateCents: 1500 }), { quantity: 3 })).toBe(4500);
  });
  it("PER_ITEM floors fractional counts", () => {
    expect(customerChargeFor(cfg({ pricingShape: "PER_ITEM", customerRateCents: 500 }), { quantity: 4.9 })).toBe(2000);
  });
  it("HOURLY multiplies by hours (decimal)", () => {
    expect(customerChargeFor(cfg({ pricingShape: "HOURLY", customerRateCents: 1000 }), { quantity: 2.5 })).toBe(2500);
  });
  it("MILEAGE rounds", () => {
    expect(customerChargeFor(cfg({ pricingShape: "MILEAGE", customerRateCents: 150 }), { quantity: 12.4 })).toBe(1860);
  });
  it("PERCENTAGE applies rate% to base quantity", () => {
    expect(customerChargeFor(cfg({ pricingShape: "PERCENTAGE", customerRateCents: 5 }), { quantity: 200000 })).toBe(10000);
  });
});

describe("platformShareFor", () => {
  it("FLAT_CENTS share", () => {
    expect(platformShareFor(cfg({ platformShareMode: "FLAT_CENTS", platformShareValue: 500 }), 4500)).toBe(500);
  });
  it("PERCENT_OF_CHARGE share", () => {
    expect(platformShareFor(cfg({ platformShareMode: "PERCENT_OF_CHARGE", platformShareValue: 50 }), 1000)).toBe(500);
  });
  it("respects the cap", () => {
    expect(platformShareFor(cfg({ platformShareMode: "PERCENT_OF_CHARGE", platformShareValue: 100, platformCapCents: 2500 }), 10000)).toBe(2500);
  });
  it("clamps to the customer charge", () => {
    expect(platformShareFor(cfg({ platformShareMode: "FLAT_CENTS", platformShareValue: 5000 }), 1000)).toBe(1000);
  });
});

describe("computeAccessorial — invariant", () => {
  it("provider = customer - platform in all cases", () => {
    for (const q of [1, 3, 12.4, 200000]) {
      for (const mode of ["FLAT_CENTS", "PERCENT_OF_CHARGE"] as const) {
        const r = computeAccessorial(cfg({ pricingShape: "HOURLY", customerRateCents: 800, platformShareMode: mode, platformShareValue: 40 }), { quantity: q });
        expect(r.providerShareCents).toBe(r.customerChargeCents - r.platformShareCents);
        expect(r.platformShareCents).toBeGreaterThanOrEqual(0);
        expect(r.platformShareCents).toBeLessThanOrEqual(r.customerChargeCents);
      }
    }
  });
});

describe("isRateWithinBand", () => {
  it("in range", () => expect(isRateWithinBand(5000, 1000, 9000)).toBe(true));
  it("below min", () => expect(isRateWithinBand(500, 1000, 9000)).toBe(false));
  it("above max", () => expect(isRateWithinBand(10000, 1000, 9000)).toBe(false));
  it("no bounds", () => expect(isRateWithinBand(10000, null, null)).toBe(true));
});

const d = (s: string) => new Date(s);
const rows: PriceRow[] = [
  { id: "nat", marketId: null, effectiveFrom: d("2026-01-01"), effectiveTo: null, isPublished: true, version: 1 },
  { id: "mkt", marketId: "M1", effectiveFrom: d("2026-06-01"), effectiveTo: null, isPublished: true, version: 1 },
  { id: "future", marketId: "M1", effectiveFrom: d("2027-01-01"), effectiveTo: null, isPublished: true, version: 2 },
  { id: "draft", marketId: "M1", effectiveFrom: d("2026-01-01"), effectiveTo: null, isPublished: false, version: 1 },
];

describe("resolvePriceRow", () => {
  it("prefers market-specific when effective", () => expect(resolvePriceRow(rows, "M1", d("2026-07-01"))?.id).toBe("mkt"));
  it("falls back to national before the market row starts", () => expect(resolvePriceRow(rows, "M1", d("2026-03-01"))?.id).toBe("nat"));
  it("national for an unknown market", () => expect(resolvePriceRow(rows, "M2", d("2026-07-01"))?.id).toBe("nat"));
  it("switches to a future row once effective", () => expect(resolvePriceRow(rows, "M1", d("2027-02-01"))?.id).toBe("future"));
  it("ignores unpublished drafts", () => expect(resolvePriceRow(rows, "M1", d("2026-07-01"))?.id).not.toBe("draft"));
  it("null when nothing matches", () => expect(resolvePriceRow([{ id: "x", marketId: "M9", effectiveFrom: d("2026-01-01"), effectiveTo: null, isPublished: true, version: 1 }], "M1", d("2026-07-01"))).toBeNull());
});

describe("isEffectiveAt", () => {
  it("half-open: end is exclusive", () => {
    const row = { effectiveFrom: d("2026-01-01"), effectiveTo: d("2026-06-01") };
    expect(isEffectiveAt(row, d("2026-06-01"))).toBe(false);
    expect(isEffectiveAt(row, d("2026-05-31"))).toBe(true);
  });
});

describe("hasOverlap", () => {
  const ex = [{ id: "a", effectiveFrom: d("2026-01-01"), effectiveTo: d("2026-06-01") }];
  it("detects an overlap", () => expect(hasOverlap(ex, { effectiveFrom: d("2026-03-01"), effectiveTo: d("2026-09-01") })).toBe(true));
  it("touching endpoints do not overlap", () => expect(hasOverlap(ex, { effectiveFrom: d("2026-06-01"), effectiveTo: null })).toBe(false));
  it("open-ended existing row overlaps later ranges", () => expect(hasOverlap([{ id: "o", effectiveFrom: d("2026-01-01"), effectiveTo: null }], { effectiveFrom: d("2030-01-01"), effectiveTo: null })).toBe(true));
  it("ignores self on update", () => expect(hasOverlap(ex, { id: "a", effectiveFrom: d("2026-01-01"), effectiveTo: d("2026-06-01") })).toBe(false));
});
