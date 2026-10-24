/**
 * Phase 5.5 portfolio moderation state machine — PURE, so the legal
 * transitions are one reviewable, testable definition rather than
 * scattered `if`s across routes. The route layer asks "can this actor
 * make this transition?" and this answers; the route does the DB write.
 *
 * Lifecycle: DRAFT → UPLOADING → PENDING → APPROVED
 *                                  ↘ REJECTED
 *            APPROVED → REMOVED → (APPROVED | PENDING)  [admin restore]
 */
import type { PortfolioModerationStatus, PortfolioProcessingStatus } from "@prisma/client";

// Worker-initiated deletes are allowed only from these states (approved
// deletion follows separate audited policy, handled in the route).
const WORKER_DELETABLE: PortfolioModerationStatus[] = ["DRAFT", "UPLOADING", "PENDING", "REJECTED"];

export function workerCanDelete(status: PortfolioModerationStatus): boolean {
  return WORKER_DELETABLE.includes(status);
}

// Admin moderation transitions.
const ADMIN_TRANSITIONS: Record<string, PortfolioModerationStatus[]> = {
  approve: ["PENDING", "REMOVED"], // can approve a pending item, or approve-on-restore
  reject: ["PENDING"],
  remove: ["APPROVED"], // only published media gets "removed"
  restore: ["REMOVED"], // restore returns to APPROVED or PENDING per policy
};

export function adminCanTransition(action: "approve" | "reject" | "remove" | "restore", from: PortfolioModerationStatus): boolean {
  return ADMIN_TRANSITIONS[action]?.includes(from) ?? false;
}

/**
 * P0-02: approval is additionally gated on image processing. When the
 * processing feature is active, an item can only be approved once its
 * pipeline has PROCESSED (EXIF stripped, dimensions/bomb-checked,
 * thumbnail generated). NOT_REQUIRED means processing is off for this
 * item (5.5A-style flow) and approval may proceed. PENDING/PROCESSING/
 * FAILED all block approval — you can't publish an image that hasn't been
 * (successfully) sanitized.
 */
export function canApproveGivenProcessing(processing: PortfolioProcessingStatus): boolean {
  return processing === "PROCESSED" || processing === "NOT_REQUIRED";
}

/** The target status a restore lands on. Policy: a restored item goes back
 *  to PENDING for re-review by default (safer than silently re-publishing),
 *  unless the caller explicitly restores-to-APPROVED. */
export function restoreTarget(toApproved: boolean): PortfolioModerationStatus {
  return toApproved ? "APPROVED" : "PENDING";
}

/** Only APPROVED, non-deleted, non-removed media is ever public. Single
 *  source of the public-visibility predicate. */
export function isPubliclyVisible(m: { status: PortfolioModerationStatus; deletedAt: Date | null; removedAt: Date | null }): boolean {
  return m.status === "APPROVED" && m.deletedAt == null && m.removedAt == null;
}

/** A new primary must be APPROVED and owned by the worker (ownership
 *  checked in the route). Setting primary clears the prior primary
 *  atomically — this predicate just gates eligibility. */
export function canBePrimary(status: PortfolioModerationStatus): boolean {
  return status === "APPROVED";
}
