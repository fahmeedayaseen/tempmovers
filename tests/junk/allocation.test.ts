import { describe, expect, it } from "vitest";
import {
  allocateJunk, DEFAULT_JUNK_ALLOCATION_POLICY, estimateDisposalCents, grossUpCents, helperCompCents, helperPayableMinutes,
  junkPlatformFeeCents, planJunkCrew, quoteJunkAllocation, settleJunk, type JunkAllocationPolicy,
} from "@/lib/junk/allocation";

// Junk allocation — VASRUE Digital Media, 29 October 2026. Every scenario the
// pay-before-dispatch work order lists (§3.3): solo, one helper, two helpers,
// five-hour full truck, minimum hours, lower and higher disposal, missing
// receipt, below-floor reprice. Carl's worked example must match to the cent.

const policy: JunkAllocationPolicy = DEFAULT_JUNK_ALLOCATION_POLICY;
const noFloor: JunkAllocationPolicy = { ...policy, haulerFloorCents: 0, truckAllowanceCents: 0 };

describe("Carl's worked example (payment spec §5, junk spec §5a)", () => {
  it("full truck, one helper: $649 − $100 disposal = $549; 30% = $164.70; helper $90; hauler $294.30 + $100 = $394.30", () => {
    const a = allocateJunk({ allInCents: 64900, disposalCents: 10000, helperCompCents: [9000], platformFeeBps: 3000 });
    expect(a.subtotalCents).toBe(54900);
    expect(a.platformFeeCents).toBe(16470);
    expect(a.helperTotalCents).toBe(9000);
    expect(a.haulerServiceCents).toBe(29430);
    expect(a.haulerTransferCents).toBe(39430);
    expect(a.platformFeeCents + a.haulerServiceCents + a.helperTotalCents + a.disposalCents).toBe(64900);
  });

  it("two helpers at the same price drop the hauler to $204.30 ($304.30 with disposal)", () => {
    const a = allocateJunk({ allInCents: 64900, disposalCents: 10000, helperCompCents: [9000, 9000], platformFeeBps: 3000 });
    expect(a.haulerServiceCents).toBe(20430);
    expect(a.haulerTransferCents).toBe(30430);
  });

  it("so a second three-hour helper raises the price by $128.58, to $777.58, and the hauler stays whole", () => {
    const q = quoteJunkAllocation({
      basePriceCents: 64900, disposalCents: 10000, bookingProtectionCents: 995, policy: noFloor,
      crew: { helperCount: 2, jobMinutes: 180, helperMinutes: [180, 180] },
    });
    expect(q.secondHelperAdjustmentCents).toBe(12858);
    expect(q.allInCents).toBe(77758);
    expect(q.haulerServiceCents).toBeGreaterThanOrEqual(29430);
    expect(q.haulerServiceCents - 29430).toBeLessThanOrEqual(1); // the fee is rounded once; any cent goes to the hauler
    expect(q.totalCents).toBe(77758 + 995);
  });
});

describe("rounding and helper time rules", () => {
  it("rounds the platform fee once, half up", () => {
    expect(junkPlatformFeeCents(54900, 3000)).toBe(16470);
    expect(junkPlatformFeeCents(15715, 3000)).toBe(4715); // 4714.5 → 4715
    expect(junkPlatformFeeCents(15714, 3000)).toBe(4714); // 4714.2 → 4714
    expect(junkPlatformFeeCents(0, 3000)).toBe(0);
  });

  it("grosses up so the net after the fee covers the amount", () => {
    expect(grossUpCents(9000, 3000)).toBe(12858);
    expect(grossUpCents(0, 3000)).toBe(0);
  });

  it("pays helpers a two-hour minimum, then in 15-minute steps", () => {
    expect(helperPayableMinutes(50, policy)).toBe(120);
    expect(helperPayableMinutes(121, policy)).toBe(135);
    expect(helperPayableMinutes(180, policy)).toBe(180);
    expect(helperCompCents(120, policy)).toBe(6000);
    expect(helperCompCents(135, policy)).toBe(6750);
  });

  it("plans two helpers for about two thirds of the one-helper time", () => {
    expect(planJunkCrew({ helperCount: 1, estimatedHours: 5 }, policy)).toEqual({ helperCount: 1, jobMinutes: 300, helperMinutes: [300] });
    expect(planJunkCrew({ helperCount: 2, estimatedHours: 5 }, policy)).toEqual({ helperCount: 2, jobMinutes: 300, helperMinutes: [210, 210] });
    expect(planJunkCrew({ helperCount: 0, estimatedHours: 1 }, policy)).toEqual({ helperCount: 0, jobMinutes: 60, helperMinutes: [] });
  });

  it("scales the disposal set-aside by load and adds special items", () => {
    expect(estimateDisposalCents({ sizeRank: 5, specialItems: [] }, policy)).toBe(13500);
    expect(estimateDisposalCents({ sizeRank: 2, specialItems: ["MATTRESS", "FREON_APPLIANCE"] }, policy)).toBe(4000 + 2500 + 2000);
  });
});

describe("quotes", () => {
  it("solo single item: no helpers, no reprice", () => {
    const q = quoteJunkAllocation({ basePriceCents: 9900, disposalCents: 1500, bookingProtectionCents: 995, policy, crew: planJunkCrew({ helperCount: 0, estimatedHours: 1 }, policy) });
    expect(q.helperTotalCents).toBe(0);
    expect(q.subtotalCents).toBe(8400);
    expect(q.platformFeeCents).toBe(2520);
    expect(q.haulerServiceCents).toBe(5880);
    expect(q.repriced).toBe(false);
    expect(q.totalCents).toBe(10895);
  });

  it("five-hour full truck with one helper", () => {
    const q = quoteJunkAllocation({ basePriceCents: 64900, disposalCents: 13500, bookingProtectionCents: 995, policy, crew: planJunkCrew({ helperCount: 1, estimatedHours: 5 }, policy) });
    expect(q.helperCompCents).toEqual([15000]);
    expect(q.subtotalCents).toBe(51400);
    expect(q.platformFeeCents).toBe(15420);
    expect(q.haulerServiceCents).toBe(20980);
    expect(q.repriced).toBe(false);
  });

  it("half truck keeps Carl's price: $329 + $9.95 = $338.95", () => {
    const q = quoteJunkAllocation({ basePriceCents: 32900, disposalCents: 8000, bookingProtectionCents: 995, policy, crew: planJunkCrew({ helperCount: 1, estimatedHours: 2 }, policy) });
    expect(q.totalCents).toBe(33895);
    expect(q.haulerServiceCents).toBe(32900 - 8000 - 7470 - 6000);
  });

  it("below the hauler floor it reprices up, never accepts an underpaid job", () => {
    // Quarter truck with a helper: at $159 the hauler would clear only $23.30.
    const q = quoteJunkAllocation({ basePriceCents: 15900, disposalCents: 4000, bookingProtectionCents: 995, policy, crew: planJunkCrew({ helperCount: 1, estimatedHours: 1.5 }, policy) });
    expect(q.repriced).toBe(true);
    expect(q.allInCents).toBe(19714);
    expect(q.floorAdjustmentCents).toBe(3814);
    expect(q.haulerServiceCents - policy.truckAllowanceCents).toBeGreaterThanOrEqual(policy.haulerFloorCents);
    // and one cent less would breach the floor
    const under = allocateJunk({ allInCents: q.allInCents - 1, disposalCents: 4000, helperCompCents: q.helperCompCents, platformFeeBps: 3000 });
    expect(under.haulerServiceCents - policy.truckAllowanceCents).toBeLessThan(policy.haulerFloorCents);
  });

  it("a two-helper hard full truck keeps the hauler at the one-helper amount", () => {
    const oneHelper = quoteJunkAllocation({ basePriceCents: 64900, disposalCents: 13500, bookingProtectionCents: 995, policy, crew: planJunkCrew({ helperCount: 1, estimatedHours: 5 }, policy) });
    const twoHelpers = quoteJunkAllocation({ basePriceCents: 64900, disposalCents: 13500, bookingProtectionCents: 995, policy, crew: planJunkCrew({ helperCount: 2, estimatedHours: 5 }, policy) });
    expect(twoHelpers.helperTotalCents).toBe(21000);
    expect(twoHelpers.secondHelperAdjustmentCents).toBe(grossUpCents(21000 - 15000, 3000));
    expect(twoHelpers.haulerServiceCents).toBeGreaterThanOrEqual(oneHelper.haulerServiceCents);
    expect(twoHelpers.haulerServiceCents - oneHelper.haulerServiceCents).toBeLessThanOrEqual(1);
  });
});

describe("settlement at completion", () => {
  const base = {
    fundedAllInCents: 64900, disposalAllowanceCents: 10000, fundedHelperCompCents: 9000,
    actualHelperMinutes: [180], approvedDisposalCents: 10000, bookingProtectionCents: 995, policy,
  };
  const sum = (s: ReturnType<typeof settleJunk>) => s.rows.reduce((a, r) => a + r.amountCents, 0);

  it("exact: reconciles to Carl's example and to the cent of what was collected", () => {
    const s = settleJunk(base);
    expect(s.platformFeeCents).toBe(16470);
    expect(s.haulerServiceCents).toBe(29430);
    expect(s.helperCompCents).toEqual([9000]);
    expect(s.disposalReimbursedCents).toBe(10000);
    expect(s.refundCents).toBe(0);
    expect(sum(s)).toBe(65895);
  });

  it("lower disposal: the difference is refunded in full and the hauler is untouched", () => {
    const s = settleJunk({ ...base, approvedDisposalCents: 7000 });
    expect(s.disposalReimbursedCents).toBe(7000);
    expect(s.disposalRefundCents).toBe(3000);
    expect(s.refundCents).toBe(3000);
    expect(s.haulerServiceCents).toBe(29430);
    expect(sum(s)).toBe(65895);
  });

  it("higher disposal with no paid change order: reimbursement capped, customer not charged, flagged", () => {
    const s = settleJunk({ ...base, approvedDisposalCents: 12500 });
    expect(s.disposalReimbursedCents).toBe(10000);
    expect(s.disposalExcessCents).toBe(2500);
    expect(s.refundCents).toBe(0);
    expect(s.exceptions.join(" ")).toMatch(/over the funded allowance/);
    expect(sum(s)).toBe(65895);
  });

  it("higher disposal with a paid change order: reimbursed in full, hauler still whole", () => {
    const s = settleJunk({ ...base, fundedAllInCents: 67400, disposalAllowanceCents: 12500, approvedDisposalCents: 12500 });
    expect(s.disposalReimbursedCents).toBe(12500);
    expect(s.haulerServiceCents).toBe(29430);
    expect(s.exceptions).toEqual([]);
    expect(sum(s)).toBe(67400 + 995);
  });

  it("missing receipt: the reimbursement is held, nothing is refunded yet", () => {
    const s = settleJunk({ ...base, approvedDisposalCents: null });
    expect(s.disposalApproved).toBe(false);
    expect(s.rows.find((r) => r.recipient === "DISPOSAL")).toMatchObject({ amountCents: 10000, held: true });
    expect(s.refundCents).toBe(0);
    expect(sum(s)).toBe(65895);
  });

  it("minimum hours: a 50-minute helper is paid two hours", () => {
    const s = settleJunk({ ...base, fundedHelperCompCents: 6000, actualHelperMinutes: [50] });
    expect(s.helperPayableMinutes).toEqual([120]);
    expect(s.helperCompCents).toEqual([6000]);
    expect(sum(s)).toBe(65895);
  });

  it("solo: no helpers at all", () => {
    const s = settleJunk({ ...base, fundedAllInCents: 9900, disposalAllowanceCents: 1500, fundedHelperCompCents: 0, actualHelperMinutes: [], approvedDisposalCents: 1500 });
    expect(s.helperActualTotalCents).toBe(0);
    expect(s.haulerServiceCents).toBe(5880);
    expect(sum(s)).toBe(9900 + 995);
  });

  it("two helpers planned, one helper's time unused: that time is refunded, not kept", () => {
    const s = settleJunk({ ...base, fundedHelperCompCents: 21000, actualHelperMinutes: [300] });
    expect(s.helperCompCents).toEqual([15000]);
    expect(s.helperUnusedRefundCents).toBe(6000);
    expect(s.refundCents).toBe(6000);
    expect(sum(s)).toBe(65895);
  });

  it("helper ran past the funded time: paid for the work, the platform carries it, the hauler is not docked", () => {
    const s = settleJunk({ ...base, actualHelperMinutes: [240] });
    expect(s.helperCompCents).toEqual([12000]);
    expect(s.helperExcessCents).toBe(3000);
    expect(s.haulerServiceCents).toBe(29430);
    expect(s.platformNetCents).toBe(16470 - 3000);
    expect(sum(s)).toBe(65895);
  });

  it("always balances to the collected amount", () => {
    for (let i = 0; i < 300; i++) {
      const allIn = 9900 + ((i * 7919) % 80000);
      const allowance = (i * 131) % 15000;
      const helpers = (i % 3);
      const funded = helpers * (6000 + ((i * 37) % 9000));
      const actual = Array.from({ length: helpers }, (_, k) => (i * 13 + k * 29) % 400);
      const approved = i % 4 === 0 ? null : (i * 97) % 20000;
      const s = settleJunk({ fundedAllInCents: allIn, disposalAllowanceCents: allowance, fundedHelperCompCents: funded, actualHelperMinutes: actual, approvedDisposalCents: approved, bookingProtectionCents: 995, policy });
      expect(sum(s)).toBe(allIn + 995);
      expect(s.haulerServiceCents).toBeGreaterThanOrEqual(0);
    }
  });
});
