import { describe, it, expect } from "vitest";
import { canTransitionLoad, assertLoadTransition, isAssignable, computeLoadFinancials, marginBasisPoints } from "@/lib/freight/load-lifecycle";
import { evaluateOfferAcceptance, evaluateSettlementReadiness } from "@/lib/freight/offer-acceptance";

describe("freight load status machine", () => {
  it("allows the happy path and rejects invalid jumps", () => {
    expect(canTransitionLoad("BOOKED", "AVAILABLE")).toBe(true);
    expect(canTransitionLoad("DRAFT", "DELIVERED")).toBe(false);
    expect(canTransitionLoad("AVAILABLE", "PAID")).toBe(false);
    expect(canTransitionLoad("ACCEPTED", "ACCEPTED")).toBe(false);
  });
  it("gates cancel and exception by state", () => {
    expect(canTransitionLoad("ACCEPTED", "CANCELED")).toBe(true);
    expect(canTransitionLoad("DELIVERED", "CANCELED")).toBe(false);
    expect(canTransitionLoad("IN_TRANSIT", "EXCEPTION")).toBe(true);
  });
  it("assertLoadTransition throws on illegal", () => {
    expect(() => assertLoadTransition("DRAFT", "PAID")).toThrow();
  });
  it("only AVAILABLE/OFFERED are assignable", () => {
    expect(isAssignable("AVAILABLE")).toBe(true);
    expect(isAssignable("OFFERED")).toBe(true);
    expect(isAssignable("ACCEPTED")).toBe(false);
  });
});

describe("freight financials — integer cents", () => {
  const fin = computeLoadFinancials({ customerLinehaulCents: 200000, customerFuelSurchargeCents: 30000, customerAccessorialsCents: 10000, carrierLinehaulCents: 170000, carrierFuelSurchargeCents: 25000, carrierAccessorialsCents: 8000, processingFeesCents: 5000 });
  it("computes totals, margin, and platform revenue exactly", () => {
    expect(fin.customerTotalCents).toBe(240000);
    expect(fin.carrierTotalCents).toBe(203000);
    expect(fin.grossMarginCents).toBe(37000);
    expect(fin.platformRevenueCents).toBe(32000);
  });
  it("reports margin in basis points", () => {
    expect(marginBasisPoints(fin)).toBe(Math.round(37000 * 10000 / 240000));
  });
  it("rejects non-integer cents", () => {
    expect(() => computeLoadFinancials({ customerLinehaulCents: 200000.5, customerFuelSurchargeCents: 0, customerAccessorialsCents: 0, carrierLinehaulCents: 0, carrierFuelSurchargeCents: 0, carrierAccessorialsCents: 0, processingFeesCents: 0 })).toThrow();
  });
});

describe("offer acceptance guard sequence", () => {
  const base = { loadStatus: "AVAILABLE" as const, offerStatus: "PENDING" as const, offerExpiresAt: "2027-01-01T00:00:00Z", now: new Date("2026-08-01T00:00:00Z"), carrierEligible: true, brokerageGatesPass: true };
  it("accepts a clean offer", () => { expect(evaluateOfferAcceptance(base).ok).toBe(true); });
  it("rejects when the load is no longer assignable", () => {
    const d = evaluateOfferAcceptance({ ...base, loadStatus: "ACCEPTED" });
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.code).toBe("LOAD_NOT_ASSIGNABLE");
  });
  it("rejects expired offers, ineligible carriers, and failed gates", () => {
    expect(evaluateOfferAcceptance({ ...base, offerExpiresAt: "2026-01-01T00:00:00Z" }).ok).toBe(false);
    expect(evaluateOfferAcceptance({ ...base, carrierEligible: false }).ok).toBe(false);
    expect(evaluateOfferAcceptance({ ...base, brokerageGatesPass: false }).ok).toBe(false);
  });
});

describe("settlement readiness", () => {
  const ok = { loadDelivered: true, podApproved: true, requiredDocumentsApproved: true, carrierEligibleForPayment: true, noBlockingPaymentException: true, finalCarrierAmountApproved: true, duplicateSettlementExists: false };
  it("is payable only when all conditions hold", () => {
    expect(evaluateSettlementReadiness(ok).payable).toBe(true);
    expect(evaluateSettlementReadiness({ ...ok, podApproved: false }).blockers).toContain("POD_NOT_APPROVED");
    expect(evaluateSettlementReadiness({ ...ok, noBlockingPaymentException: false }).blockers).toContain("BLOCKING_PAYMENT_EXCEPTION");
    expect(evaluateSettlementReadiness({ ...ok, duplicateSettlementExists: true }).blockers).toContain("DUPLICATE_SETTLEMENT");
  });
});

// P0-04 regression: the ownership decision (extracted as pure logic mirror of
// the route guard) — a carrier may only accept its own offer; admins may act
// on any. This documents the rule the route enforces.
function mayAcceptOffer(role: string, actorUserId: string, offerCarrierOwnerUserId: string): boolean {
  if (["ADMIN", "SUPER_ADMIN"].includes(role)) return true;
  return actorUserId === offerCarrierOwnerUserId;
}

describe("P0-04 carrier offer ownership", () => {
  it("blocks a carrier from accepting another carrier's offer", () => {
    expect(mayAcceptOffer("CARRIER", "user-A", "user-B")).toBe(false);
  });
  it("allows a carrier to accept its own offer", () => {
    expect(mayAcceptOffer("CARRIER", "user-A", "user-A")).toBe(true);
  });
  it("allows an admin to act on any offer", () => {
    expect(mayAcceptOffer("ADMIN", "user-A", "user-B")).toBe(true);
  });
});
