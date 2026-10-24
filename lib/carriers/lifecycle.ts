/**
 * Carrier lifecycle logic (launch spec phase 3), PURE and testable.
 *
 * Enforces the spec's rules:
 *  #1 A carrier cannot receive loads merely because it created an account.
 *  #2 APPROVED = compliance review passed; ACTIVE = currently eligible.
 *  #3 Expired insurance automatically removes load eligibility.
 *
 * Nothing here does I/O; the routes supply current state + insurance dates.
 */

export type CarrierStatus =
  | "APPLICATION_STARTED" | "DOCUMENTS_PENDING" | "UNDER_REVIEW" | "APPROVED"
  | "ACTIVE" | "TEMPORARILY_INACTIVE" | "SUSPENDED" | "REJECTED" | "EXPIRED_DOCUMENTS";

/**
 * Allowed status transitions. A carrier moves forward through review; it can't
 * leap from APPLICATION_STARTED to ACTIVE. ACTIVE is only reachable from
 * APPROVED (compliance passed) or from a reversible inactive state.
 */
const ALLOWED: Record<CarrierStatus, CarrierStatus[]> = {
  APPLICATION_STARTED: ["DOCUMENTS_PENDING", "UNDER_REVIEW", "REJECTED"],
  DOCUMENTS_PENDING: ["UNDER_REVIEW", "REJECTED", "APPLICATION_STARTED"],
  UNDER_REVIEW: ["APPROVED", "REJECTED", "DOCUMENTS_PENDING"],
  APPROVED: ["ACTIVE", "SUSPENDED", "EXPIRED_DOCUMENTS"],
  ACTIVE: ["TEMPORARILY_INACTIVE", "SUSPENDED", "EXPIRED_DOCUMENTS"],
  TEMPORARILY_INACTIVE: ["ACTIVE", "SUSPENDED", "EXPIRED_DOCUMENTS"],
  SUSPENDED: ["UNDER_REVIEW", "REJECTED"],
  REJECTED: ["APPLICATION_STARTED"],
  EXPIRED_DOCUMENTS: ["UNDER_REVIEW", "ACTIVE", "SUSPENDED"], // ACTIVE only via re-check (route enforces insurance valid)
};

export function canTransition(from: CarrierStatus, to: CarrierStatus): boolean {
  if (from === to) return false;
  return (ALLOWED[from] ?? []).includes(to);
}

export function assertTransition(from: CarrierStatus, to: CarrierStatus): void {
  if (!canTransition(from, to)) {
    throw new Error(`Illegal carrier status transition: ${from} -> ${to}`);
  }
}

export type InsurancePolicyView = {
  type: "AUTO_LIABILITY" | "CARGO" | "GENERAL_LIABILITY";
  expiresAt: string | null;
};

/** True if a policy of this type exists and is not expired as of `now`. */
export function hasValidInsurance(policies: InsurancePolicyView[], type: InsurancePolicyView["type"], now: Date): boolean {
  return policies.some((p) => p.type === type && p.expiresAt != null && new Date(p.expiresAt).getTime() > now.getTime());
}

export type LoadEligibilityInput = {
  status: CarrierStatus;
  policies: InsurancePolicyView[];
  now: Date;
  /** Which insurance types this carrier must carry to haul (auto liability always; cargo for freight). */
  requiredInsurance: InsurancePolicyView["type"][];
};

export type LoadEligibility = { eligible: boolean; reasons: string[] };

/**
 * Single source of truth for "can this carrier receive load opportunities?"
 * Rule #1/#2: must be ACTIVE (not merely APPROVED, not merely an account).
 * Rule #3: every required insurance must be present and unexpired.
 */
export function evaluateLoadEligibility(input: LoadEligibilityInput): LoadEligibility {
  const reasons: string[] = [];
  if (input.status !== "ACTIVE") {
    reasons.push(`Carrier status is ${input.status}; must be ACTIVE to receive loads.`);
  }
  for (const req of input.requiredInsurance) {
    if (!hasValidInsurance(input.policies, req, input.now)) {
      reasons.push(`Missing or expired ${req} insurance.`);
    }
  }
  return { eligible: reasons.length === 0, reasons };
}

/**
 * Given current status and insurance validity, returns EXPIRED_DOCUMENTS if an
 * ACTIVE carrier's required insurance has lapsed (rule #3 — auto-remove
 * eligibility). Returns null if no auto-transition is needed.
 */
export function autoExpireIfInsuranceLapsed(
  status: CarrierStatus,
  policies: InsurancePolicyView[],
  requiredInsurance: InsurancePolicyView["type"][],
  now: Date,
): CarrierStatus | null {
  if (status !== "ACTIVE") return null;
  const lapsed = requiredInsurance.some((req) => !hasValidInsurance(policies, req, now));
  return lapsed ? "EXPIRED_DOCUMENTS" : null;
}
