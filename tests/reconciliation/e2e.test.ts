import { describe, it, expect } from "vitest";
import { calculateJobQuote, calculateSemiLoadQuote, calculateBoxTruckLoadQuote } from "@/lib/pricing";
import { computeAccessorial } from "@/lib/accessorials/compute";
import { reconcile, reconcilesToZero, type TransactionLine } from "@/lib/reconciliation/model";

/**
 * END-TO-END RECONCILIATION SUITE.
 *
 * For every completed job/load, the identity
 *   Customer Charged − Provider Paid = Platform Revenue
 * must hold with $0.00 variance, and once Stripe fees are accounted as a
 * platform cost, the full identity must also net to zero — after accessorials
 * AND after refunds.
 *
 * These tests build each line from the REAL pricing + accessorial code (not
 * hand-typed numbers) and feed it through the reconciliation model, so a
 * regression in any pricing function surfaces here as a non-zero variance.
 */

// Helper: build accessorials from the real engine for a set of specs.
function buildAccessorials(specs: { shape: any; rate: number; shareMode: any; shareValue: number; cap?: number; qty: number }[]) {
  return specs.map(s => computeAccessorial(
    { pricingShape: s.shape, customerRateCents: s.rate, platformShareMode: s.shareMode, platformShareValue: s.shareValue, platformCapCents: s.cap ?? null },
    { quantity: s.qty },
  ));
}

describe("Moving labor (ADD_TO_CUSTOMER) reconciliation", () => {
  it("reconciles to $0.00 with accessorials", () => {
    // 2 movers, 4h, $60/hr. In the ADD model the customer pays labor + fee +
    // booking protection; the provider (movers) receive the full labor.
    const q = calculateJobQuote({ moverHourlyRateCents: 6000, movers: 2, estimatedHours: 4 });
    const providerBase = q.moverPayoutPerWorkerCents * q.movers; // movers get full labor
    // Accessorials: a stairs charge (PER_FLIGHT) and a heavy-item fee (FLAT),
    // platform takes a cut of each.
    const acc = buildAccessorials([
      { shape: "PER_FLIGHT", rate: 1500, shareMode: "FLAT_CENTS", shareValue: 500, qty: 3 },
      { shape: "FLAT", rate: 10000, shareMode: "PERCENT_OF_CHARGE", shareValue: 20, qty: 1 },
    ]);
    const line: TransactionLine = {
      customerBaseCents: q.totalCents,        // customer pays full quote (incl fee + protection)
      providerBaseCents: providerBase,        // movers get labor only
      accessorials: acc,
      stripeFeeCents: 0,
    };
    const r = reconcile(line);
    expect(r.variance).toBe(0);
    expect(reconcilesToZero(line)).toBe(true);
    // Sanity: platform kept the fee + protection + accessorial platform shares.
    const accPlatform = acc.reduce((s, a) => s + a.platformShareCents, 0);
    expect(r.platformRevenue).toBe((q.totalCents - providerBase) + accPlatform);
  });
});

describe("Semi freight (DEDUCT_FROM_PROVIDER) reconciliation", () => {
  it("reconciles to $0.00 with accessorials and a Stripe fee", () => {
    // $2,000 load, deduct model: customer pays 2000, carrier nets 1900.
    const q = calculateSemiLoadQuote(200000, "DEDUCT_FROM_PROVIDER");
    const acc = buildAccessorials([
      { shape: "PERCENTAGE", rate: 5, shareMode: "PERCENT_OF_CHARGE", shareValue: 100, cap: 2500, qty: 200000 }, // detention 5%, platform capped 2500
    ]);
    // Customer pays load price + accessorial customer charge; provider nets
    // carrier payout + accessorial provider share.
    const accCustomer = acc.reduce((s, a) => s + a.customerChargeCents, 0);
    const accProvider = acc.reduce((s, a) => s + a.providerShareCents, 0);
    const line: TransactionLine = {
      customerBaseCents: q.customerTotalCents,     // 200000
      providerBaseCents: q.carrierPayoutCents,     // 190000
      accessorials: acc,
      stripeFeeCents: 6000, // arbitrary Stripe fee, a platform cost
    };
    const r = reconcile(line);
    expect(r.variance).toBe(0);
    expect(r.stripeVariance).toBe(0);
    // customer charged / provider paid reflect base + accessorials
    expect(r.customerCharged).toBe(200000 + accCustomer);
    expect(r.providerPaid).toBe(190000 + accProvider);
  });
});

describe("Box-truck freight (DEDUCT) reconciliation", () => {
  it("reconciles to $0.00", () => {
    const q = calculateBoxTruckLoadQuote({ driverPayoutCents: 100000, feeModel: "DEDUCT_FROM_PROVIDER" });
    const line: TransactionLine = {
      customerBaseCents: q.customerTotalCents, // 100000
      providerBaseCents: q.carrierPayoutCents, // 95000
      accessorials: [],
      stripeFeeCents: 3000,
    };
    expect(reconcile(line).variance).toBe(0);
    expect(reconcilesToZero(line)).toBe(true);
  });
});

describe("Refund reconciliation", () => {
  it("full refund of an accessorial nets that line to zero and still reconciles", () => {
    const q = calculateSemiLoadQuote(200000, "DEDUCT_FROM_PROVIDER");
    const acc = buildAccessorials([{ shape: "FLAT", rate: 5000, shareMode: "PERCENT_OF_CHARGE", shareValue: 40, qty: 1 }]);
    const a = acc[0];
    const line: TransactionLine = {
      customerBaseCents: q.customerTotalCents,
      providerBaseCents: q.carrierPayoutCents,
      accessorials: acc,
      stripeFeeCents: 0,
      // Refund the whole accessorial: reverse each portion.
      refunds: [{ customerCents: a.customerChargeCents, providerCents: a.providerShareCents, platformCents: a.platformShareCents }],
    };
    const r = reconcile(line);
    expect(r.variance).toBe(0);
    // After the refund, the accessorial contributes nothing net.
    expect(r.customerCharged).toBe(q.customerTotalCents);
    expect(r.providerPaid).toBe(q.carrierPayoutCents);
  });

  it("partial refund still reconciles to zero", () => {
    const q = calculateJobQuote({ moverHourlyRateCents: 5000, movers: 2, estimatedHours: 3 });
    const providerBase = q.moverPayoutPerWorkerCents * q.movers;
    const line: TransactionLine = {
      customerBaseCents: q.totalCents,
      providerBaseCents: providerBase,
      accessorials: [],
      stripeFeeCents: 0,
      // Refund $50 of platform revenue (e.g. a goodwill fee waiver) — платформ
      // portion only, customer gets money back, provider unaffected.
      refunds: [{ customerCents: 5000, providerCents: 0, platformCents: 5000 }],
    };
    const r = reconcile(line);
    expect(r.variance).toBe(0);
    expect(r.customerCharged).toBe(q.totalCents - 5000);
    expect(r.platformRevenue).toBe((q.totalCents - providerBase) - 5000);
  });
});

describe("Fuzz: many random completed transactions all reconcile to zero", () => {
  it("holds across 500 randomized lines", () => {
    let checked = 0;
    for (let i = 0; i < 500; i++) {
      const movers = 2 + (i % 4);
      const hours = 3 + (i % 6);
      const rate = 4000 + (i % 50) * 100;
      const q = calculateJobQuote({ moverHourlyRateCents: rate, movers, estimatedHours: hours });
      const acc = buildAccessorials([
        { shape: "PER_ITEM", rate: 300 + (i % 10) * 50, shareMode: "PERCENT_OF_CHARGE", shareValue: (i % 100), qty: (i % 5) + 1 },
        { shape: "HOURLY", rate: 1000 + (i % 20) * 100, shareMode: "FLAT_CENTS", shareValue: (i % 300), qty: (i % 4) + 0.5 },
      ]);
      const line: TransactionLine = {
        customerBaseCents: q.totalCents,
        providerBaseCents: q.moverPayoutPerWorkerCents * q.movers,
        accessorials: acc,
        stripeFeeCents: (i % 40) * 25,
        refunds: i % 7 === 0 ? [{ customerCents: acc[0].customerChargeCents, providerCents: acc[0].providerShareCents, platformCents: acc[0].platformShareCents }] : undefined,
      };
      expect(reconcile(line).variance).toBe(0);
      expect(reconcile(line).stripeVariance).toBe(0);
      checked++;
    }
    expect(checked).toBe(500);
  });
});
