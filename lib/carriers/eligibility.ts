/**
 * Centralized carrier eligibility (launch spec §3). The SINGLE source of truth
 * every future load-offer and carrier-assignment endpoint must call.
 *
 * Split into a PURE core (computeCarrierEligibility — takes a fully-gathered
 * snapshot, returns structured blockers) and a DB-backed wrapper
 * (getCarrierEligibility, in ./eligibility-service.ts) that gathers the
 * snapshot. This keeps the decision logic exhaustively testable.
 *
 * Returns STRUCTURED results ({ eligible, blockers: [{code, message}] }), not a
 * bare boolean, so callers and the UI can show exactly what's missing.
 */
import { hasValidInsurance, type CarrierStatus, type InsurancePolicyView } from "@/lib/carriers/lifecycle";

export type EligibilityBlocker = { code: string; message: string };
export type EligibilityResult = { eligible: boolean; blockers: EligibilityBlocker[] };

export type EligibilitySnapshot = {
  carrierStatus: CarrierStatus;
  // documents & insurance
  requiredInsurance: InsurancePolicyView["type"][];
  policies: InsurancePolicyView[];
  requiredApprovedDocuments: string[];      // e.g. ["W9","CARRIER_AGREEMENT"]
  approvedDocuments: string[];              // which required docs are admin-approved
  // FMCSA
  fmcsaAuthorized: boolean | null;          // null = never checked / unknown
  fmcsaCheckedAt: string | null;
  fmcsaStale: boolean;
  fmcsaRequired: boolean;
  // agreement
  hasActiveRequiredAgreement: boolean;
  agreementRequired: boolean;
  // payment routing
  paymentRoutingUnderReview: boolean;       // an unresolved routing exception
  // market
  marketEligible: boolean;                  // market active + service enabled for this capability
  // compliance flags
  globalCapabilityEnabled: boolean;         // for brokerage-gated capabilities
  capabilityRequiresBrokerage: boolean;     // does this capability sit behind the brokerage gate?
  marketBrokerageEnabled: boolean;
  // admin hold
  administrativeHold: boolean;
  now: Date;
};

export function computeCarrierEligibility(s: EligibilitySnapshot): EligibilityResult {
  const blockers: EligibilityBlocker[] = [];

  // 1. Carrier must be ACTIVE (not merely APPROVED / an account).
  if (s.carrierStatus !== "ACTIVE") {
    blockers.push({ code: "CARRIER_NOT_ACTIVE", message: `Carrier status is ${s.carrierStatus}; must be ACTIVE.` });
  }

  // 2. Administrative hold / suspension short-circuits everything else meaningfully,
  //    but we still report all blockers for transparency.
  if (s.administrativeHold) {
    blockers.push({ code: "ADMINISTRATIVE_HOLD", message: "Carrier is under an administrative hold." });
  }

  // 3. Required insurance present + unexpired.
  for (const req of s.requiredInsurance) {
    if (!hasValidInsurance(s.policies, req, s.now)) {
      blockers.push({ code: `${req}_INSURANCE_INVALID`, message: `${req} insurance is missing or expired.` });
    }
  }

  // 4. Required documents approved.
  for (const doc of s.requiredApprovedDocuments) {
    if (!s.approvedDocuments.includes(doc)) {
      blockers.push({ code: `DOCUMENT_NOT_APPROVED_${doc}`, message: `Required document ${doc} is not approved.` });
    }
  }

  // 5. FMCSA verification (when required): must be authorized and not stale.
  if (s.fmcsaRequired) {
    if (s.fmcsaAuthorized !== true) {
      blockers.push({ code: "FMCSA_NOT_AUTHORIZED", message: "FMCSA authority is not verified as active." });
    } else if (s.fmcsaStale) {
      blockers.push({ code: "FMCSA_CHECK_STALE", message: "FMCSA verification is out of date and must be re-checked." });
    }
  }

  // 6. Agreement.
  if (s.agreementRequired && !s.hasActiveRequiredAgreement) {
    blockers.push({ code: "AGREEMENT_MISSING", message: "A required signed agreement is not active." });
  }

  // 7. Payment-routing review (an unresolved routing exception blocks eligibility
  //    so a load can't be assigned while remittance is in dispute).
  if (s.paymentRoutingUnderReview) {
    blockers.push({ code: "PAYMENT_ROUTING_UNDER_REVIEW", message: "Payment routing has an unresolved review." });
  }

  // 8. Market eligibility.
  if (!s.marketEligible) {
    blockers.push({ code: "MARKET_NOT_ELIGIBLE", message: "This capability is not enabled in the carrier's market." });
  }

  // 9. Compliance flags — brokerage-gated capabilities require global + market on.
  if (s.capabilityRequiresBrokerage) {
    if (!s.globalCapabilityEnabled) {
      blockers.push({ code: "BROKERAGE_DISABLED", message: "Freight brokerage capability is not enabled." });
    }
    if (!s.marketBrokerageEnabled) {
      blockers.push({ code: "MARKET_BROKERAGE_DISABLED", message: "Freight brokerage is not enabled in this market." });
    }
  }

  return { eligible: blockers.length === 0, blockers };
}
