/**
 * Single source of truth for what an applicant/worker can do with a job or
 * load opportunity at each stage of compliance. Every list, detail,
 * request, accept, and assignment route should call this rather than
 * re-deriving its own version of these rules — that's exactly how the
 * duplicate/disagreeing-gate bugs found in earlier rounds happened.
 *
 * This is intentionally narrower than lib/worker-eligibility.ts's
 * evaluateWorkerEligibility(): that function answers "is this worker
 * allowed to touch loads/jobs/payouts at all" (subscription, Stripe,
 * onboarding). This one answers "given that baseline, what can they see
 * and do with THIS SPECIFIC opportunity" — sanitized preview vs. full
 * detail, request vs. assigned-only detail. Call both: eligibility first
 * (unchanged from prior rounds), then this for the opportunity-specific
 * question.
 */

import { prisma } from "@/lib/db";

export type OpportunityAction = "BROWSE_PREVIEW" | "REQUEST" | "ACCEPT" | "VIEW_PRIVATE_DETAILS" | "VIEW_ASSIGNED_DETAILS";

export type WorkerAccessSnapshot = {
  workerId: string;
  accountStatus: string; // WorkerProfile.operationalStatus
  screeningStatus: string | null; // ScreeningCharge.status, latest
  complianceApproved: boolean; // WorkerCompliance.adminApprovalStatus === APPROVED
};

export type OpportunityAccessSnapshot = {
  assignedWorkerId: string | null;
};

export type AccessDecision = {
  allowed: boolean;
  reasonCode?: string;
  missingRequirements: string[];
};

function getMissingRequirements(worker: WorkerAccessSnapshot): string[] {
  const missing: string[] = [];
  if (!["PAID", "SCREENING_ORDERED", "SCREENING_PENDING", "APPROVED"].includes(worker.screeningStatus ?? "")) {
    missing.push("SCREENING_PAYMENT");
  }
  if (!worker.complianceApproved) missing.push("COMPLIANCE_APPROVAL");
  return missing;
}

export function evaluateOpportunityAccess(
  worker: WorkerAccessSnapshot,
  opportunity: OpportunityAccessSnapshot,
  action: OpportunityAction,
): AccessDecision {
  // Sanitized browsing is always allowed once signed in — that's the whole
  // point of showing sanitized previews pre-approval. The missing
  // requirements are still surfaced so the UI can show a checklist.
  if (action === "BROWSE_PREVIEW") {
    return { allowed: true, missingRequirements: getMissingRequirements(worker) };
  }

  const missing = getMissingRequirements(worker);
  if (missing.length > 0) {
    return { allowed: false, reasonCode: "COMPLIANCE_INCOMPLETE", missingRequirements: missing };
  }

  if (!["APPROVED", "ACTIVE"].includes(worker.accountStatus)) {
    return { allowed: false, reasonCode: "ACCOUNT_NOT_ACTIVE", missingRequirements: [] };
  }

  if (action === "VIEW_PRIVATE_DETAILS") {
    // Private details (exact address, contact info, documents) are never
    // available pre-assignment, no matter how compliant the worker is —
    // that's a hard rule, not a compliance-tier gate.
    return { allowed: false, reasonCode: "ASSIGNMENT_REQUIRED", missingRequirements: [] };
  }

  if (action === "VIEW_ASSIGNED_DETAILS") {
    const assigned = opportunity.assignedWorkerId === worker.workerId;
    return { allowed: assigned, reasonCode: assigned ? undefined : "ASSIGNMENT_REQUIRED", missingRequirements: [] };
  }

  // REQUEST / ACCEPT
  return { allowed: true, missingRequirements: [] };
}

/**
 * Builds a WorkerAccessSnapshot from the database and evaluates it in one
 * call — the convenience path every request/accept route should use rather
 * than re-deriving the snapshot construction itself.
 */
export async function checkOpportunityAccess(
  workerId: string,
  opportunity: OpportunityAccessSnapshot,
  action: OpportunityAction,
): Promise<AccessDecision> {
  const worker = await prisma.workerProfile.findUnique({
    where: { id: workerId },
    include: {
      compliance: true,
      screeningCharges: { orderBy: { createdAt: "desc" }, take: 1 },
    },
  });
  if (!worker) return { allowed: false, reasonCode: "WORKER_NOT_FOUND", missingRequirements: [] };

  return evaluateOpportunityAccess(
    {
      workerId: worker.id,
      accountStatus: worker.operationalStatus,
      screeningStatus: worker.screeningCharges[0]?.status ?? null,
      complianceApproved: worker.compliance?.adminApprovalStatus === "APPROVED",
    },
    opportunity,
    action,
  );
}
