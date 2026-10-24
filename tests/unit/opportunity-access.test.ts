import { describe, it, expect } from "vitest";
import { evaluateOpportunityAccess, type WorkerAccessSnapshot } from "@/lib/access/opportunity-access";

const unscreenedWorker: WorkerAccessSnapshot = {
  workerId: "w1", accountStatus: "ACTIVE", screeningStatus: null, complianceApproved: false,
};
const paidNotApprovedWorker: WorkerAccessSnapshot = {
  workerId: "w1", accountStatus: "ACTIVE", screeningStatus: "PAID", complianceApproved: false,
};
const approvedWorker: WorkerAccessSnapshot = {
  workerId: "w1", accountStatus: "ACTIVE", screeningStatus: "APPROVED", complianceApproved: true,
};

describe("evaluateOpportunityAccess", () => {
  it("always allows sanitized browsing, even fully unscreened", () => {
    const result = evaluateOpportunityAccess(unscreenedWorker, { assignedWorkerId: null }, "BROWSE_PREVIEW");
    expect(result.allowed).toBe(true);
  });

  it("blocks REQUEST for an unscreened worker", () => {
    const result = evaluateOpportunityAccess(unscreenedWorker, { assignedWorkerId: null }, "REQUEST");
    expect(result.allowed).toBe(false);
    expect(result.reasonCode).toBe("COMPLIANCE_INCOMPLETE");
    expect(result.missingRequirements).toContain("SCREENING_PAYMENT");
  });

  it("blocks REQUEST for a worker who paid but isn't admin-approved yet", () => {
    const result = evaluateOpportunityAccess(paidNotApprovedWorker, { assignedWorkerId: null }, "REQUEST");
    expect(result.allowed).toBe(false);
    expect(result.missingRequirements).toContain("COMPLIANCE_APPROVAL");
  });

  it("allows REQUEST and ACCEPT for a fully approved worker", () => {
    expect(evaluateOpportunityAccess(approvedWorker, { assignedWorkerId: null }, "REQUEST").allowed).toBe(true);
    expect(evaluateOpportunityAccess(approvedWorker, { assignedWorkerId: null }, "ACCEPT").allowed).toBe(true);
  });

  it("NEVER allows VIEW_PRIVATE_DETAILS pre-assignment, even for a fully approved worker", () => {
    const result = evaluateOpportunityAccess(approvedWorker, { assignedWorkerId: null }, "VIEW_PRIVATE_DETAILS");
    expect(result.allowed).toBe(false);
    expect(result.reasonCode).toBe("ASSIGNMENT_REQUIRED");
  });

  it("allows VIEW_ASSIGNED_DETAILS only for the worker actually assigned", () => {
    const assignedToMe = evaluateOpportunityAccess(approvedWorker, { assignedWorkerId: "w1" }, "VIEW_ASSIGNED_DETAILS");
    expect(assignedToMe.allowed).toBe(true);

    const assignedToSomeoneElse = evaluateOpportunityAccess(approvedWorker, { assignedWorkerId: "someone-else" }, "VIEW_ASSIGNED_DETAILS");
    expect(assignedToSomeoneElse.allowed).toBe(false);
    expect(assignedToSomeoneElse.reasonCode).toBe("ASSIGNMENT_REQUIRED");
  });

  it("blocks everything but BROWSE_PREVIEW for a non-active account even if compliant", () => {
    const suspended: WorkerAccessSnapshot = { ...approvedWorker, accountStatus: "SUSPENDED" };
    const result = evaluateOpportunityAccess(suspended, { assignedWorkerId: null }, "REQUEST");
    expect(result.allowed).toBe(false);
    expect(result.reasonCode).toBe("ACCOUNT_NOT_ACTIVE");
  });
});
