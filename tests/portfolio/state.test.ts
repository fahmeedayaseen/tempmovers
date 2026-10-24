import { describe, it, expect } from "vitest";
import { workerCanDelete, adminCanTransition, restoreTarget, isPubliclyVisible, canBePrimary, canApproveGivenProcessing } from "@/lib/portfolio/state";
import { normalizeDisplayOrder, cleanupReason, selectCleanupTargets, DEFAULT_CLEANUP_CONFIG, type CleanupCandidate } from "@/lib/portfolio/cleanup";

describe("canApproveGivenProcessing (P0-02)", () => {
  it("allows approval when processed or not required", () => {
    expect(canApproveGivenProcessing("PROCESSED")).toBe(true);
    expect(canApproveGivenProcessing("NOT_REQUIRED")).toBe(true);
  });
  it("blocks approval while pending/processing/failed", () => {
    expect(canApproveGivenProcessing("PENDING")).toBe(false);
    expect(canApproveGivenProcessing("PROCESSING")).toBe(false);
    expect(canApproveGivenProcessing("FAILED")).toBe(false);
  });
});

describe("workerCanDelete", () => {
  it("allows deleting non-approved states", () => {
    for (const s of ["DRAFT", "UPLOADING", "PENDING", "REJECTED"] as const) expect(workerCanDelete(s)).toBe(true);
  });
  it("does not allow APPROVED/REMOVED via this predicate", () => {
    expect(workerCanDelete("APPROVED")).toBe(false);
    expect(workerCanDelete("REMOVED")).toBe(false);
  });
});

describe("adminCanTransition", () => {
  it("approve from PENDING or REMOVED", () => {
    expect(adminCanTransition("approve", "PENDING")).toBe(true);
    expect(adminCanTransition("approve", "REMOVED")).toBe(true);
    expect(adminCanTransition("approve", "APPROVED")).toBe(false);
  });
  it("reject only from PENDING", () => {
    expect(adminCanTransition("reject", "PENDING")).toBe(true);
    expect(adminCanTransition("reject", "APPROVED")).toBe(false);
  });
  it("remove only from APPROVED", () => {
    expect(adminCanTransition("remove", "APPROVED")).toBe(true);
    expect(adminCanTransition("remove", "PENDING")).toBe(false);
  });
  it("restore only from REMOVED", () => {
    expect(adminCanTransition("restore", "REMOVED")).toBe(true);
    expect(adminCanTransition("restore", "APPROVED")).toBe(false);
  });
});

describe("restoreTarget", () => {
  it("defaults to PENDING, opt-in to APPROVED", () => {
    expect(restoreTarget(false)).toBe("PENDING");
    expect(restoreTarget(true)).toBe("APPROVED");
  });
});

describe("isPubliclyVisible", () => {
  it("only approved + not deleted + not removed", () => {
    expect(isPubliclyVisible({ status: "APPROVED", deletedAt: null, removedAt: null })).toBe(true);
    expect(isPubliclyVisible({ status: "PENDING", deletedAt: null, removedAt: null })).toBe(false);
    expect(isPubliclyVisible({ status: "APPROVED", deletedAt: new Date(), removedAt: null })).toBe(false);
    expect(isPubliclyVisible({ status: "APPROVED", deletedAt: null, removedAt: new Date() })).toBe(false);
  });
});

describe("canBePrimary", () => {
  it("only approved media", () => {
    expect(canBePrimary("APPROVED")).toBe(true);
    expect(canBePrimary("PENDING")).toBe(false);
  });
});

describe("normalizeDisplayOrder", () => {
  it("produces gap-free 0..n-1 in the given order", () => {
    expect(normalizeDisplayOrder(["c", "a", "b"])).toEqual([
      { id: "c", displayOrder: 0 }, { id: "a", displayOrder: 1 }, { id: "b", displayOrder: 2 },
    ]);
  });
});

describe("cleanupReason / selectCleanupTargets", () => {
  const base = (over: Partial<CleanupCandidate>): CleanupCandidate => ({
    id: "m", status: "UPLOADING", deletedAt: null, rejectedAt: null, removedAt: null, uploadedAt: null, submittedAt: null, createdAt: new Date(), ...over,
  });
  const now = new Date("2026-08-01T00:00:00Z");
  const daysAgo = (d: number) => new Date(now.getTime() - d * 24 * 60 * 60 * 1000);

  it("flags soft-deleted immediately", () => {
    expect(cleanupReason(base({ deletedAt: now }), now)).toBe("deleted");
  });
  it("flags stale never-finalized uploads past the orphan window", () => {
    expect(cleanupReason(base({ status: "UPLOADING", createdAt: daysAgo(2) }), now)).toBe("orphan");
    expect(cleanupReason(base({ status: "UPLOADING", createdAt: daysAgo(0) }), now)).toBeNull();
  });
  it("flags rejected media past the appeal window", () => {
    expect(cleanupReason(base({ status: "REJECTED", rejectedAt: daysAgo(31) }), now)).toBe("rejected-expired");
    expect(cleanupReason(base({ status: "REJECTED", rejectedAt: daysAgo(1) }), now)).toBeNull();
  });
  it("flags removed media past retention", () => {
    expect(cleanupReason(base({ status: "REMOVED", removedAt: daysAgo(31) }), now)).toBe("removed-expired");
  });
  it("does not flag a healthy approved item", () => {
    expect(cleanupReason(base({ status: "APPROVED", uploadedAt: daysAgo(5), createdAt: daysAgo(5) }), now)).toBeNull();
  });
  it("selectCleanupTargets returns only flagged rows", () => {
    const rows = [base({ id: "keep", status: "APPROVED", uploadedAt: daysAgo(1), createdAt: daysAgo(1) }), base({ id: "gone", deletedAt: now })];
    const out = selectCleanupTargets(rows, now, DEFAULT_CLEANUP_CONFIG);
    expect(out).toEqual([{ id: "gone", reason: "deleted" }]);
  });
});
