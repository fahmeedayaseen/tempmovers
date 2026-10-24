/**
 * Payment-routing change control (launch-required factoring rule). PURE.
 *
 * THE RULE: when a verified Notice of Assignment is active, carrier payments
 * must follow the approved remittance instructions. A carrier must NOT be able
 * to change the destination without administrative review, supporting
 * documentation, and an audit entry.
 *
 * This module decides whether a proposed remittance change is allowed to take
 * effect immediately or must be routed through admin review. The route layer
 * enforces the decision and always writes a PaymentRoutingAudit row.
 */

export type ActiveAssignmentView = {
  status: "PENDING_REVIEW" | "ACTIVE" | "SUPERSEDED" | "REVOKED";
  noaVerified: boolean; // is the backing Notice of Assignment verified?
};

export type RemittanceChangeRequest = {
  actorIsAdmin: boolean;
  hasSupportingDocument: boolean;
  reason?: string | null;
};

export type ChangeDecision =
  | { allowed: true; requiresReview: false }
  | { allowed: false; requiresReview: true; reason: string };

/**
 * Decide whether a remittance-destination change may be applied directly.
 *
 * - If there is an ACTIVE assignment backed by a VERIFIED NOA, a carrier (non-
 *   admin) can NEVER change the destination directly — it must go to admin
 *   review with supporting docs. Only an admin, WITH a supporting document,
 *   may apply the change.
 * - With no active verified NOA, the change follows normal carrier profile
 *   rules (allowed), but the caller still audits it.
 */
export function evaluateRemittanceChange(
  active: ActiveAssignmentView | null,
  req: RemittanceChangeRequest,
): ChangeDecision {
  const lockedByNoa = active != null && active.status === "ACTIVE" && active.noaVerified;

  if (lockedByNoa) {
    if (!req.actorIsAdmin) {
      return { allowed: false, requiresReview: true, reason: "An active Notice of Assignment is in effect; only administrative review can change the remittance destination." };
    }
    if (!req.hasSupportingDocument) {
      return { allowed: false, requiresReview: true, reason: "Changing remittance under an active Notice of Assignment requires supporting documentation." };
    }
    // Admin + supporting doc → allowed (and audited by the caller).
    return { allowed: true, requiresReview: false };
  }

  // No active verified NOA — change permitted (still audited).
  return { allowed: true, requiresReview: false };
}
