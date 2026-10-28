import { describe, expect, it } from "vitest";
import {
  calculateJunkQuote, DEFAULT_JUNK_PRICE_TABLE, JunkQuoteError, resolveJunkPriceTable, toPublicJunkQuote,
  type JunkQuoteInput,
} from "@/lib/junk/pricing";

// Junk removal — VASRUE Digital Media, 28 October 2026. Checks the pricing
// engine against Carl's junk spec: his proposed prices (§5), the 70/30 split
// taken out of one all-in price (§5a/§5b), the minimum floor, special items
// (§6) and crew sizing.

const base: JunkQuoteInput = {
  table: DEFAULT_JUNK_PRICE_TABLE,
  takeRatePercent: 30,
  helperSharePercent: 25,
  bookingProtectionCents: 995,
  pricingMode: "VOLUME",
  volumeTier: "QUARTER",
  specialItems: [],
  itemLocation: "CURBSIDE",
  hasHeavyItems: false,
};

describe("junk pricing — volume tiers", () => {
  it("prices a quarter truck at $159 all-in, with the 30% take inside the price, not on top", () => {
    const q = calculateJunkQuote(base);
    expect(q.servicePriceCents).toBe(15900);
    expect(q.allInCents).toBe(15900);
    expect(q.platformTakeCents).toBe(4770);
    expect(q.crewPoolCents).toBe(11130); // spec §5b: hauler 70% of $159 ≈ $111
    expect(q.totalCents).toBe(15900 + 995); // only booking protection is added
    expect(q.feeModel).toBe("DEDUCT_FROM_PROVIDER");
  });

  it("matches the spec's hauler shares at $329 and $649", () => {
    expect(calculateJunkQuote({ ...base, volumeTier: "HALF" }).crewPoolCents).toBe(23030);
    expect(calculateJunkQuote({ ...base, volumeTier: "FULL" }).crewPoolCents).toBe(45430);
  });

  it("never stacks the fee on the customer — the $206.70 the spec's label would have produced", () => {
    const q = calculateJunkQuote(base);
    expect(q.allInCents).not.toBe(20670);
  });

  it("rejects a volume booking with no tier", () => {
    expect(() => calculateJunkQuote({ ...base, volumeTier: null })).toThrow(JunkQuoteError);
  });
});

describe("junk pricing — items, minimum and special items", () => {
  it("prices items individually and applies the $99 minimum to a lone TV", () => {
    const q = calculateJunkQuote({ ...base, pricingMode: "ITEMS", volumeTier: null, items: [{ code: "TV_ELECTRONICS", quantity: 1 }] });
    expect(q.servicePriceCents).toBe(9900);
    expect(q.lines.some((l) => l.label === "Minimum charge adjustment" && l.cents === 5000)).toBe(true);
  });

  it("sums quantities across items", () => {
    const q = calculateJunkQuote({ ...base, pricingMode: "ITEMS", volumeTier: null, items: [{ code: "MATTRESS", quantity: 2 }, { code: "SOFA", quantity: 1 }] });
    expect(q.servicePriceCents).toBe(8900 * 2 + 9900);
  });

  it("adds a configured surcharge on a volume job, inside the split", () => {
    const table = resolveJunkPriceTable({ surchargesCents: { FREON_APPLIANCE: 2500 } });
    const q = calculateJunkQuote({ ...base, table, specialItems: ["FREON_APPLIANCE"] });
    expect(q.surchargesCents).toBe(2500);
    expect(q.allInCents).toBe(15900 + 2500);
    expect(q.platformTakeCents + q.crewPoolCents).toBe(q.allInCents);
  });

  it("does not surcharge a special item the per-item price already covers", () => {
    const table = resolveJunkPriceTable({ surchargesCents: { FREON_APPLIANCE: 2500 } });
    const q = calculateJunkQuote({ ...base, table, pricingMode: "ITEMS", volumeTier: null, items: [{ code: "FRIDGE_FREEZER", quantity: 1 }], specialItems: ["FREON_APPLIANCE"] });
    expect(q.surchargesCents).toBe(0);
    expect(q.servicePriceCents).toBe(11900);
  });

  it("rejects out-of-range quantities", () => {
    expect(() => calculateJunkQuote({ ...base, pricingMode: "ITEMS", volumeTier: null, items: [{ code: "SOFA", quantity: 0 }] })).toThrow(JunkQuoteError);
    expect(() => calculateJunkQuote({ ...base, pricingMode: "ITEMS", volumeTier: null, items: [{ code: "SOFA", quantity: 21 }] })).toThrow(JunkQuoteError);
  });
});

describe("junk pricing — crew size and shares", () => {
  it("sends one hauler alone for a small curbside job", () => {
    const q = calculateJunkQuote({ ...base, volumeTier: "EIGHTH" });
    expect(q.helpersRequired).toBe(0);
    expect(q.haulerShareCents).toBe(q.crewPoolCents);
  });

  it("adds a helper for anything inside, heavy or bigger", () => {
    expect(calculateJunkQuote({ ...base, volumeTier: "EIGHTH", itemLocation: "INSIDE_GROUND" }).helpersRequired).toBe(1);
    expect(calculateJunkQuote({ ...base, volumeTier: "HALF" }).helpersRequired).toBe(1);
  });

  it("sends two helpers for a large heavy job, and the hauler keeps every rounding cent", () => {
    const q = calculateJunkQuote({ ...base, volumeTier: "FULL", hasHeavyItems: true });
    expect(q.helpersRequired).toBe(2);
    expect(q.helperShareCents).toBe(Math.floor((45430 * 25) / 100));
    expect(q.haulerShareCents + 2 * q.helperShareCents).toBe(q.crewPoolCents);
    expect(q.haulerShareCents).toBeGreaterThan(q.helperShareCents);
  });

  it("refuses a helper share that would leave the hauler less than 10%", () => {
    expect(() => calculateJunkQuote({ ...base, helperSharePercent: 46 })).toThrow(JunkQuoteError);
  });
});

describe("junk pricing — price table overrides", () => {
  it("merges a partial override over the defaults", () => {
    const t = resolveJunkPriceTable({ tiersCents: { QUARTER: 17900 }, minimumCents: 12900 });
    expect(t.tiersCents.QUARTER).toBe(17900);
    expect(t.tiersCents.HALF).toBe(32900);
    expect(t.minimumCents).toBe(12900);
  });

  it("falls back to the defaults entirely on a malformed stored value", () => {
    expect(resolveJunkPriceTable({ tiersCents: { QUARTER: -5 } })).toEqual(DEFAULT_JUNK_PRICE_TABLE);
    expect(resolveJunkPriceTable({ unknownKey: 1 })).toEqual(DEFAULT_JUNK_PRICE_TABLE);
  });

  it("keeps the crew split out of the customer-facing quote", () => {
    const pub = toPublicJunkQuote(calculateJunkQuote(base)) as Record<string, unknown>;
    for (const k of ["platformTakeCents", "crewPoolCents", "haulerShareCents", "helperShareCents", "takeRatePercent", "helperSharePercent"]) {
      expect(k in pub).toBe(false);
    }
    expect(pub.totalCents).toBe(16895);
  });
});
