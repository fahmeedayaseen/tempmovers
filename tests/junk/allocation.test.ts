import { describe, expect, it } from "vitest";
import {
  allocateJunk, DEFAULT_JUNK_ALLOCATION_POLICY, estimateDisposalCents, grossUpCents, helperCompCents, helperPayableMinutes,
  junkPlatformFeeCents, planJunkCrew, quoteJunkAllocation, settleJunk, settleJunkCrew, type JunkAllocationPolicy,
} from "@/lib/junk/allocation";

// Junk allocation — MODEL B (2 Nov 2026). One flat all-inclusive price; the 30%
// platform fee is on the FULL price; disposal is an internal estimate only
// (never billed, reimbursed or refunded); up to 10 helpers are grossed into the
// price so the hauler is never docked; a quote below the hauler floor reprices
// up; an underfunded settlement HOLDS rather than emitting a negative row; and
// who supplies the crew (PLATFORM/OWN/HYBRID) changes only the payees.

const policy: JunkAllocationPolicy = DEFAULT_JUNK_ALLOCATION_POLICY;
const noFloor: JunkAllocationPolicy = { ...policy, haulerFloorCents: 0, truckAllowanceCents: 0 };
// The default base includes 1 helper (includedHelperCount: 1). This variant
// bills every helper (base is hauler-only) — used for the item illustration.
const allAdditional: JunkAllocationPolicy = { ...noFloor, includedHelperCount: 0 };

describe("Model B allocation (fee on the full price, disposal internal)", () => {
  it("$649 full load: 30% of the FULL price = $194.70; hauler residual = $454.30; nothing added back for disposal", () => {
    const a = allocateJunk({ allInCents: 64900, disposalEstimateCents: 10000, helperCompCents: [], platformFeeBps: 3000 });
    expect(a.platformFeeCents).toBe(19470);
    expect(a.haulerServiceCents).toBe(45430);
    expect(a.haulerTransferCents).toBe(45430); // no disposal reimbursement
    expect(a.platformFeeCents + a.haulerServiceCents + a.helperTotalCents).toBe(64900);
  });

  it("base includes 1 helper: 1 helper = base price, each extra billed at $42.86/helper-hour", () => {
    const rate = grossUpCents(policy.helperHourlyCents, 3000); // $30 / 0.70 → $42.86
    expect(rate).toBe(4286);
    const one = quoteJunkAllocation({ basePriceCents: 64900, disposalEstimateCents: 10000, bookingProtectionCents: 0, policy, crew: planJunkCrew({ helperCount: 1, estimatedHours: 2 }, policy) });
    expect(one.allInCents).toBe(64900); // first helper included, nothing added
    const two = quoteJunkAllocation({ basePriceCents: 64900, disposalEstimateCents: 10000, bookingProtectionCents: 0, policy, crew: planJunkCrew({ helperCount: 2, estimatedHours: 2 }, policy) });
    expect(two.helperGrossUpCents).toBe(8572); // 1 extra × 2h × $42.86
    expect(two.allInCents).toBe(73472);
  });

  it("worked example (crew-pricing handoff): 4 helpers × 3h → $1,034.74 total, $310.42 fee, $364.32 hauler service", () => {
    const q = quoteJunkAllocation({ basePriceCents: 64900, disposalEstimateCents: 10000, bookingProtectionCents: 0, policy, crew: planJunkCrew({ helperCount: 4, estimatedHours: 3 }, policy) });
    expect(q.helperGrossUpCents).toBe(38574); // 3 extra × 3h × $42.86
    expect(q.allInCents).toBe(103474);
    expect(q.platformFeeCents).toBe(31042); // 30% of the full total
    expect(q.allInCents - q.platformFeeCents).toBe(72432); // 70% settlement pool
    expect(q.helperTotalCents).toBe(36000); // 4 × 3h × $30 actual worker cost
    expect(q.haulerServiceCents).toBe(36432); // hauler service residual (pool − all helper comp)
  });

  it("the hauler's base settlement is never reduced by adding helpers (1..10 ≥ base; 0 helpers = full residual)", () => {
    const solo = quoteJunkAllocation({ basePriceCents: 64900, disposalEstimateCents: 10000, bookingProtectionCents: 0, policy, crew: planJunkCrew({ helperCount: 0, estimatedHours: 2 }, policy) });
    expect(solo.haulerServiceCents).toBe(45430); // no helper to pay from the base
    for (let n = 1; n <= 10; n++) {
      const q = quoteJunkAllocation({ basePriceCents: 64900, disposalEstimateCents: 10000, bookingProtectionCents: 0, policy, crew: planJunkCrew({ helperCount: n, estimatedHours: 2 }, policy) });
      expect(q.haulerServiceCents).toBeGreaterThanOrEqual(39430); // base settlement, never docked
      expect(q.haulerServiceCents - 39430).toBeLessThanOrEqual(n); // only per-helper-hour rounding, in the hauler's favour
    }
  });

  it("item base in all-additional mode (includedHelperCount: 0) bills both helpers", () => {
    const q = quoteJunkAllocation({ basePriceCents: 20000, disposalEstimateCents: 0, bookingProtectionCents: 0, policy: allAdditional, crew: planJunkCrew({ helperCount: 2, estimatedHours: 2 }, allAdditional) });
    expect(q.helperGrossUpCents).toBe(17144); // 2 helpers × 2h × $42.86
    expect(q.allInCents).toBe(37144);
    expect(q.helperTotalCents).toBe(12000);
  });
});

describe("rounding, gross-up, helper time and disposal estimate", () => {
  it("rounds the platform fee once, half up", () => {
    expect(junkPlatformFeeCents(64900, 3000)).toBe(19470);
    expect(junkPlatformFeeCents(15715, 3000)).toBe(4715); // 4714.5 → 4715
    expect(junkPlatformFeeCents(15714, 3000)).toBe(4714); // 4714.2 → 4714
    expect(junkPlatformFeeCents(0, 3000)).toBe(0);
  });

  it("grosses up so the net after the fee covers the amount", () => {
    expect(grossUpCents(9000, 3000)).toBe(12858);
    expect(grossUpCents(6000, 3000)).toBe(8572);
    expect(grossUpCents(0, 3000)).toBe(0);
  });

  it("pays helpers a two-hour minimum, then in 15-minute steps", () => {
    expect(helperPayableMinutes(50, policy)).toBe(120);
    expect(helperPayableMinutes(121, policy)).toBe(135);
    expect(helperPayableMinutes(180, policy)).toBe(180);
    expect(helperCompCents(120, policy)).toBe(6000);
    expect(helperCompCents(135, policy)).toBe(6750);
  });

  it("plans each helper for the full job time, and rejects an out-of-range count", () => {
    expect(planJunkCrew({ helperCount: 1, estimatedHours: 5 }, policy)).toEqual({ helperCount: 1, jobMinutes: 300, helperMinutes: [300] });
    expect(planJunkCrew({ helperCount: 2, estimatedHours: 5 }, policy)).toEqual({ helperCount: 2, jobMinutes: 300, helperMinutes: [300, 300] });
    expect(planJunkCrew({ helperCount: 0, estimatedHours: 1 }, policy)).toEqual({ helperCount: 0, jobMinutes: 60, helperMinutes: [] });
    expect(() => planJunkCrew({ helperCount: 11, estimatedHours: 2 }, policy)).toThrow();
    expect(() => planJunkCrew({ helperCount: 1.5, estimatedHours: 2 }, policy)).toThrow();
  });

  it("validates fee basis points and cents", () => {
    expect(() => allocateJunk({ allInCents: 64900, disposalEstimateCents: 0, helperCompCents: [], platformFeeBps: 10000 })).toThrow();
    expect(() => allocateJunk({ allInCents: -1, disposalEstimateCents: 0, helperCompCents: [], platformFeeBps: 3000 })).toThrow();
  });

  it("scales the internal disposal estimate by load and adds special items", () => {
    expect(estimateDisposalCents({ sizeRank: 5, specialItems: [] }, policy)).toBe(13500);
    expect(estimateDisposalCents({ sizeRank: 2, specialItems: ["MATTRESS", "FREON_APPLIANCE"] }, policy)).toBe(4000 + 2500 + 2000);
  });
});

describe("quotes", () => {
  it("solo single item: no helpers, no reprice, flat price", () => {
    const q = quoteJunkAllocation({ basePriceCents: 9900, disposalEstimateCents: 1500, bookingProtectionCents: 995, policy, crew: planJunkCrew({ helperCount: 0, estimatedHours: 1 }, policy) });
    expect(q.helperTotalCents).toBe(0);
    expect(q.platformFeeCents).toBe(2970); // 30% of the full 9900
    expect(q.haulerServiceCents).toBe(6930);
    expect(q.repriced).toBe(false);
    expect(q.totalCents).toBe(10895);
  });

  it("below the hauler floor it reprices up, never accepts an underpaid job", () => {
    // $20 base, no helpers: hauler would clear only $14; floor+truck+disposal = $65.
    const q = quoteJunkAllocation({ basePriceCents: 2000, disposalEstimateCents: 1500, bookingProtectionCents: 995, policy, crew: planJunkCrew({ helperCount: 0, estimatedHours: 0.5 }, policy) });
    expect(q.repriced).toBe(true);
    expect(q.allInCents).toBe(9286);
    expect(q.haulerServiceCents).toBe(6500);
    expect(q.haulerServiceCents - policy.truckAllowanceCents - 1500).toBeGreaterThanOrEqual(policy.haulerFloorCents);
    const under = allocateJunk({ allInCents: q.allInCents - 1, disposalEstimateCents: 1500, helperCompCents: [], platformFeeBps: 3000 });
    expect(under.haulerServiceCents - policy.truckAllowanceCents - 1500).toBeLessThan(policy.haulerFloorCents);
  });

  it("a two-helper full truck keeps the hauler at the one-helper amount (±1¢ rounding)", () => {
    const one = quoteJunkAllocation({ basePriceCents: 64900, disposalEstimateCents: 13500, bookingProtectionCents: 995, policy, crew: planJunkCrew({ helperCount: 1, estimatedHours: 5 }, policy) });
    const two = quoteJunkAllocation({ basePriceCents: 64900, disposalEstimateCents: 13500, bookingProtectionCents: 995, policy, crew: planJunkCrew({ helperCount: 2, estimatedHours: 5 }, policy) });
    expect(two.helperTotalCents).toBe(30000);
    expect(two.helperGrossUpCents).toBe(Math.ceil((grossUpCents(3000, 3000) * 300) / 60)); // 1 extra helper × 5h at $42.86/hr
    expect(two.haulerServiceCents).toBeGreaterThanOrEqual(one.haulerServiceCents);
    expect(two.haulerServiceCents - one.haulerServiceCents).toBeLessThanOrEqual(1);
  });
});

describe("settlement at completion (Model B: no disposal reimbursement, no routine refund)", () => {
  const base = { fundedAllInCents: 73472, actualHelperMinutes: [120], actualDisposalCents: 10000, bookingProtectionCents: 995, policy };
  const sum = (s: ReturnType<typeof settleJunk>) => s.rows.reduce((a, r) => a + r.amountCents, 0);

  it("exact: fee on full price, helper paid, hauler residual, balances, no disposal/refund rows", () => {
    const s = settleJunk(base);
    expect(s.requiresHold).toBe(false);
    expect(s.platformFeeCents).toBe(22042);
    expect(s.helperCompCents).toEqual([6000]);
    expect(s.haulerServiceCents).toBe(45430);
    expect(sum(s)).toBe(74467);
    expect(s.rows.some((r) => (r.recipient as string) === "DISPOSAL" || (r.recipient as string) === "CUSTOMER_REFUND")).toBe(false);
    expect(s.actualDisposalCents).toBe(10000); // echoed for admin margin only
  });

  it("minimum hours: a 50-minute helper is paid two hours", () => {
    const s = settleJunk({ ...base, actualHelperMinutes: [50] });
    expect(s.helperPayableMinutes).toEqual([120]);
    expect(s.helperCompCents).toEqual([6000]);
    expect(sum(s)).toBe(74467);
  });

  it("solo: no helpers", () => {
    const s = settleJunk({ ...base, fundedAllInCents: 9900, actualHelperMinutes: [] });
    expect(s.haulerServiceCents).toBe(6930);
    expect(sum(s)).toBe(10895);
  });

  it("C4 — hauler below the approved minimum (overtime overrun): HOLD for review, no sub-minimum auto-pay", () => {
    // $200 funded, 300-min helper = $150: hauler would be 20000−6000−15000 = −1000 < floor.
    const s = settleJunk({ ...base, fundedAllInCents: 20000, actualHelperMinutes: [300] });
    expect(s.requiresHold).toBe(true);
    expect(s.rows.length).toBe(0);
    expect(s.platformNetCents).toBe(0);
  });

  it("underfunded: HOLD, no rows released, obligation recorded, no negative platform row", () => {
    const s = settleJunk({ ...base, fundedAllInCents: 10000, actualHelperMinutes: [420] });
    expect(s.requiresHold).toBe(true);
    expect(s.rows.length).toBe(0);
    expect(s.platformNetCents).toBeGreaterThanOrEqual(0);
    expect(s.unfundedObligationCents).toBe(11000);
  });

  it("always balances to the collected amount, or holds — never a negative row, never below the floor", () => {
    for (let i = 0; i < 400; i++) {
      const allIn = 2000 + ((i * 7919) % 120000);
      const helpers = i % 4;
      const actual = Array.from({ length: helpers }, (_, k) => (i * 13 + k * 29) % 500);
      const s = settleJunk({ fundedAllInCents: allIn, actualHelperMinutes: actual, actualDisposalCents: (i * 97) % 20000, bookingProtectionCents: 995, policy });
      expect(s.rows.every((r) => r.amountCents >= 0)).toBe(true);
      if (s.requiresHold) expect(s.rows.length).toBe(0);
      else {
        expect(sum(s)).toBe(allIn + 995);
        expect(s.haulerServiceCents).toBeGreaterThanOrEqual(policy.haulerFloorCents); // never settles below the floor
      }
    }
  });
});

describe("crew fulfillment routing (PLATFORM / OWN / HYBRID)", () => {
  it("worked example: 2 hauler + 2 TM helpers @3h → hauler business gets $544.32 (service + own crew), TM workers $180, reconciled", () => {
    // Funded at the 4-helper price from the pricing handoff ($1,034.74).
    const s = settleJunkCrew({
      fundedAllInCents: 103474, bookingProtectionCents: 0, requiredHelperCount: 4, haulerPayeeId: "hauler_biz",
      committedCrew: [
        { source: "OWN", payeeId: "hauler_biz", requiredBySafety: true },
        { source: "OWN", payeeId: "hauler_biz", requiredBySafety: true },
        { source: "PLATFORM", payeeId: "wkr_A", requiredBySafety: true },
        { source: "PLATFORM", payeeId: "wkr_B", requiredBySafety: true },
      ],
      attendance: [0, 1, 2, 3].map((i) => ({ slotIndex: i, attended: true, verified: true, actualMinutes: 180 })),
      policy,
    });
    expect(s.requiresHold).toBe(false);
    expect(s.platformNetCents).toBe(31042); // $310.42
    expect(s.haulerServiceCents).toBe(36432); // internal service residual, NOT the hauler transfer
    const hauler = s.transfers.find((t) => t.recipient === "HAULER_BUSINESS")!;
    expect(hauler.amountCents).toBe(54432); // $544.32 = service $364.32 + own-crew 2 × $90
    expect(hauler.parts).toEqual({ serviceCents: 36432, ownCrewHelperCents: 18000 });
    const workers = s.transfers.filter((t) => t.recipient === "WORKER");
    expect(workers.reduce((a, t) => a + t.amountCents, 0)).toBe(18000); // 2 TM helpers × $90, paid separately
    expect(s.transfers.reduce((a, t) => a + t.amountCents, 0)).toBe(103474); // reconciles to the customer payment
  });

  it("hybrid: each verified helper paid once to its own payee; hauler business = service + own crew", () => {
    const s = settleJunkCrew({
      fundedAllInCents: 37143, bookingProtectionCents: 0, requiredHelperCount: 2, haulerPayeeId: "hauler_biz",
      committedCrew: [{ source: "PLATFORM", payeeId: "wkr_A", requiredBySafety: true }, { source: "OWN", payeeId: "hauler_biz", requiredBySafety: true }],
      attendance: [{ slotIndex: 0, attended: true, verified: true, actualMinutes: 120 }, { slotIndex: 1, attended: true, verified: true, actualMinutes: 120 }],
      policy,
    });
    expect(s.requiresHold).toBe(false);
    expect(s.mode).toBe("HYBRID");
    expect(s.haulerServiceCents).toBe(14000); // internal residual
    const hauler = s.transfers.find((t) => t.recipient === "HAULER_BUSINESS")!;
    expect(hauler.amountCents).toBe(20000); // $140 service + $60 own helper
    expect(s.transfers.filter((t) => t.recipient === "WORKER").reduce((a, t) => a + t.amountCents, 0)).toBe(6000); // the one TM helper
    expect(s.transfers.reduce((a, t) => a + t.amountCents, 0)).toBe(37143);
  });

  it("hauler arrives short of the committed/safety crew: HOLD, and the missing helper's pay is never redirected to the hauler", () => {
    const s = settleJunkCrew({
      fundedAllInCents: 37143, bookingProtectionCents: 0, requiredHelperCount: 2, haulerPayeeId: "hauler_biz",
      committedCrew: [{ source: "OWN", payeeId: "hauler_biz", requiredBySafety: true }, { source: "OWN", payeeId: "hauler_biz", requiredBySafety: true }],
      attendance: [{ slotIndex: 0, attended: true, verified: true, actualMinutes: 120 }, { slotIndex: 1, attended: false, verified: false, actualMinutes: 0 }],
      policy,
    });
    expect(s.requiresHold).toBe(true);
    expect(s.rows.length).toBe(0);
    expect(s.transfers.length).toBe(0);
    expect(s.haulerServiceCents).toBe(0);
    expect(s.withheldForUnsuppliedCrewCents).toBe(0);
  });

  it("duplicate / unknown attendance records hold, they do not throw", () => {
    const dup = settleJunkCrew({
      fundedAllInCents: 37143, bookingProtectionCents: 0, requiredHelperCount: 2, haulerPayeeId: "hauler_biz",
      committedCrew: [{ source: "PLATFORM", payeeId: "wkr_A", requiredBySafety: true }, { source: "PLATFORM", payeeId: "wkr_B", requiredBySafety: true }],
      attendance: [{ slotIndex: 0, attended: true, verified: true, actualMinutes: 120 }, { slotIndex: 0, attended: true, verified: true, actualMinutes: 120 }],
      policy,
    });
    expect(dup.requiresHold).toBe(true);
    const unknown = settleJunkCrew({
      fundedAllInCents: 37143, bookingProtectionCents: 0, requiredHelperCount: 1, haulerPayeeId: "hauler_biz",
      committedCrew: [{ source: "PLATFORM", payeeId: "wkr_A", requiredBySafety: true }],
      attendance: [{ slotIndex: 5, attended: true, verified: true, actualMinutes: 120 }],
      policy,
    });
    expect(unknown.requiresHold).toBe(true);
  });

  it("a verified slot with no approved payee holds (no post-funding payee swap)", () => {
    const s = settleJunkCrew({
      fundedAllInCents: 37143, bookingProtectionCents: 0, requiredHelperCount: 2, haulerPayeeId: "hauler_biz",
      committedCrew: [{ source: "OWN", payeeId: null, requiredBySafety: true }, { source: "OWN", payeeId: "hauler_biz", requiredBySafety: true }],
      attendance: [{ slotIndex: 0, attended: true, verified: true, actualMinutes: 120 }, { slotIndex: 1, attended: true, verified: true, actualMinutes: 120 }],
      policy,
    });
    expect(s.requiresHold).toBe(true);
    expect(s.rows.length).toBe(0);
  });
});
