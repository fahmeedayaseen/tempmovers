/**
 * Carrier offer acceptance — the ordered guard sequence (freight phase), PURE.
 * The route runs these checks INSIDE a serializable transaction that locks the
 * load; this module encodes the decision so the ordering + failure reasons are
 * testable. Two carriers cannot accept the same load because the load must
 * still be assignable at check time and the accepted offer flips it atomically.
 */
import { isAssignable, type LoadStatus } from "@/lib/freight/load-lifecycle";

export type OfferStatus = "PENDING" | "VIEWED" | "ACCEPTED" | "DECLINED" | "EXPIRED" | "WITHDRAWN" | "SUPERSEDED";

export type AcceptOfferInput = {
  loadStatus: LoadStatus;         // current, read under lock
  offerStatus: OfferStatus;       // the offer being accepted
  offerExpiresAt: string;         // ISO
  now: Date;
  carrierEligible: boolean;       // rechecked via getCarrierEligibility
  brokerageGatesPass: boolean;    // master + capability + market + permission
};

export type AcceptDecision =
  | { ok: true }
  | { ok: false; code: string; message: string };

/**
 * Ordered checks (spec steps 2-4). Returns the FIRST failure so the caller
 * aborts the transaction with a precise reason; only { ok: true } proceeds to
 * mark the offer, expire competitors, create the assignment, and audit.
 */
export function evaluateOfferAcceptance(input: AcceptOfferInput): AcceptDecision {
  // 2. Load must still be assignable (not already ACCEPTED by someone else).
  if (!isAssignable(input.loadStatus)) {
    return { ok: false, code: "LOAD_NOT_ASSIGNABLE", message: `Load is ${input.loadStatus}; no longer assignable.` };
  }
  // Offer itself must be live.
  if (input.offerStatus !== "PENDING" && input.offerStatus !== "VIEWED") {
    return { ok: false, code: "OFFER_NOT_OPEN", message: `Offer is ${input.offerStatus}.` };
  }
  if (new Date(input.offerExpiresAt).getTime() <= input.now.getTime()) {
    return { ok: false, code: "OFFER_EXPIRED", message: "Offer has expired." };
  }
  // 3. Recheck carrier eligibility.
  if (!input.carrierEligible) {
    return { ok: false, code: "CARRIER_INELIGIBLE", message: "Carrier is no longer eligible." };
  }
  // 4. Recheck brokerage + market gates.
  if (!input.brokerageGatesPass) {
    return { ok: false, code: "BROKERAGE_GATES_FAILED", message: "Brokerage/market/permission gates did not pass." };
  }
  return { ok: true };
}

/**
 * Settlement-payable preconditions (spec "Carrier settlement" section). PURE.
 * Every condition must hold before a settlement may be created/paid.
 */
export type SettlementReadinessInput = {
  loadDelivered: boolean;
  podApproved: boolean;
  requiredDocumentsApproved: boolean;
  carrierEligibleForPayment: boolean;
  noBlockingPaymentException: boolean;
  finalCarrierAmountApproved: boolean;
  duplicateSettlementExists: boolean;
};

export function evaluateSettlementReadiness(i: SettlementReadinessInput): { payable: boolean; blockers: string[] } {
  const blockers: string[] = [];
  if (!i.loadDelivered) blockers.push("LOAD_NOT_DELIVERED");
  if (!i.podApproved) blockers.push("POD_NOT_APPROVED");
  if (!i.requiredDocumentsApproved) blockers.push("DOCUMENTS_NOT_APPROVED");
  if (!i.carrierEligibleForPayment) blockers.push("CARRIER_NOT_ELIGIBLE");
  if (!i.noBlockingPaymentException) blockers.push("BLOCKING_PAYMENT_EXCEPTION");
  if (!i.finalCarrierAmountApproved) blockers.push("FINAL_AMOUNT_NOT_APPROVED");
  if (i.duplicateSettlementExists) blockers.push("DUPLICATE_SETTLEMENT");
  return { payable: blockers.length === 0, blockers };
}
