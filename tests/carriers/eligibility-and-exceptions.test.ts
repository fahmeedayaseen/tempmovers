import { describe, it, expect } from "vitest";
import { computeCarrierEligibility, type EligibilitySnapshot } from "@/lib/carriers/eligibility";
import { classifyPaymentExceptions, hasBlockingPaymentException, type PaymentExceptionInput } from "@/lib/carriers/payment-exceptions";
import { processExpiryBatch } from "@/lib/carriers/expiration-batch";

const now = new Date("2026-08-01T00:00:00Z");
const fut = "2027-01-01T00:00:00Z";
const past = "2026-01-01T00:00:00Z";

const goodSnapshot: EligibilitySnapshot = {
  carrierStatus: "ACTIVE",
  requiredInsurance: ["AUTO_LIABILITY", "CARGO"],
  policies: [{ type: "AUTO_LIABILITY", expiresAt: fut }, { type: "CARGO", expiresAt: fut }],
  requiredApprovedDocuments: ["W9"],
  approvedDocuments: ["W9"],
  fmcsaAuthorized: true, fmcsaCheckedAt: "2026-07-20T00:00:00Z", fmcsaStale: false, fmcsaRequired: true,
  hasActiveRequiredAgreement: true, agreementRequired: false,
  paymentRoutingUnderReview: false,
  marketEligible: true,
  globalCapabilityEnabled: true, capabilityRequiresBrokerage: false, marketBrokerageEnabled: false,
  administrativeHold: false,
  now,
};

describe("centralized carrier eligibility — structured blockers", () => {
  it("a fully compliant ACTIVE carrier is eligible", () => {
    const r = computeCarrierEligibility(goodSnapshot);
    expect(r.eligible).toBe(true);
    expect(r.blockers).toHaveLength(0);
  });
  it("returns coded, human-readable blockers", () => {
    const r = computeCarrierEligibility({ ...goodSnapshot, carrierStatus: "APPROVED" });
    expect(r.eligible).toBe(false);
    expect(r.blockers[0].code).toBe("CARRIER_NOT_ACTIVE");
    expect(typeof r.blockers[0].message).toBe("string");
  });
  it("flags expired cargo insurance specifically", () => {
    const r = computeCarrierEligibility({ ...goodSnapshot, policies: [{ type: "AUTO_LIABILITY", expiresAt: fut }, { type: "CARGO", expiresAt: past }] });
    expect(r.blockers.some((b) => b.code === "CARGO_INSURANCE_INVALID")).toBe(true);
  });
  it("flags stale and unauthorized FMCSA", () => {
    expect(computeCarrierEligibility({ ...goodSnapshot, fmcsaAuthorized: false }).blockers.some((b) => b.code === "FMCSA_NOT_AUTHORIZED")).toBe(true);
    expect(computeCarrierEligibility({ ...goodSnapshot, fmcsaStale: true }).blockers.some((b) => b.code === "FMCSA_CHECK_STALE")).toBe(true);
  });
  it("blocks on unresolved payment routing and administrative hold", () => {
    expect(computeCarrierEligibility({ ...goodSnapshot, paymentRoutingUnderReview: true }).blockers.some((b) => b.code === "PAYMENT_ROUTING_UNDER_REVIEW")).toBe(true);
    expect(computeCarrierEligibility({ ...goodSnapshot, administrativeHold: true }).blockers.some((b) => b.code === "ADMINISTRATIVE_HOLD")).toBe(true);
  });
  it("brokerage-gated capability requires global + market brokerage on", () => {
    const base = { ...goodSnapshot, capabilityRequiresBrokerage: true, agreementRequired: true, hasActiveRequiredAgreement: true };
    expect(computeCarrierEligibility({ ...base, globalCapabilityEnabled: false, marketBrokerageEnabled: true }).blockers.some((b) => b.code === "BROKERAGE_DISABLED")).toBe(true);
    expect(computeCarrierEligibility({ ...base, globalCapabilityEnabled: true, marketBrokerageEnabled: false }).blockers.some((b) => b.code === "MARKET_BROKERAGE_DISABLED")).toBe(true);
  });
  it("accumulates multiple blockers", () => {
    const r = computeCarrierEligibility({ ...goodSnapshot, carrierStatus: "APPROVED", approvedDocuments: [], fmcsaAuthorized: false });
    expect(r.blockers.length).toBeGreaterThanOrEqual(3);
  });
});

const cleanExceptions: PaymentExceptionInput = {
  pendingNoaReview: false, replacementNoaPending: false, letterOfReleasePending: false,
  conflictingInstructions: false, expiredAssignment: false, routingChangeRequested: false,
  blockedDirectPaymentAttempt: false, missingSupportingDocument: false,
};

describe("payment exception queue — payout gate", () => {
  it("no exceptions means payout may proceed", () => {
    expect(hasBlockingPaymentException(cleanExceptions)).toBe(false);
  });
  it("any exception halts payout", () => {
    expect(hasBlockingPaymentException({ ...cleanExceptions, pendingNoaReview: true })).toBe(true);
    expect(hasBlockingPaymentException({ ...cleanExceptions, expiredAssignment: true })).toBe(true);
  });
  it("accumulates and codes each exception", () => {
    const list = classifyPaymentExceptions({ ...cleanExceptions, pendingNoaReview: true, conflictingInstructions: true });
    expect(list).toHaveLength(2);
    expect(list.some((e) => e.code === "CONFLICTING_PAYMENT_INSTRUCTIONS")).toBe(true);
  });
});

describe("expiration batch — warnings and auto-transition", () => {
  it("emits a warning at a threshold and transitions on lapse", () => {
    const d30 = new Date(now.getTime() + 30 * 864e5).toISOString();
    const warn = processExpiryBatch([{ carrierId: "c1", status: "ACTIVE", requiredInsurance: ["AUTO_LIABILITY"], policies: [{ type: "AUTO_LIABILITY", expiresAt: d30 }], documents: [] }], now);
    expect(warn.warnings.some((w) => w.daysUntilExpiry === 30)).toBe(true);

    const lapse = processExpiryBatch([{ carrierId: "c2", status: "ACTIVE", requiredInsurance: ["AUTO_LIABILITY"], policies: [{ type: "AUTO_LIABILITY", expiresAt: past }], documents: [] }], now);
    expect(lapse.transitions.some((t) => t.to === "EXPIRED_DOCUMENTS")).toBe(true);
  });
  it("leaves a healthy carrier untouched", () => {
    const r = processExpiryBatch([{ carrierId: "c3", status: "ACTIVE", requiredInsurance: ["AUTO_LIABILITY"], policies: [{ type: "AUTO_LIABILITY", expiresAt: fut }], documents: [] }], now);
    expect(r.warnings).toHaveLength(0);
    expect(r.transitions).toHaveLength(0);
  });
});
