/**
 * Phase 5.5 pure helpers for display-order normalization and cleanup
 * eligibility. No db/S3 — the route supplies rows, these compute the
 * decisions, the route/job persists them.
 */
import type { PortfolioModerationStatus } from "@prisma/client";

/**
 * Normalize an ordered list of media IDs into contiguous 0..n-1
 * displayOrder values. Given the worker's desired order (array of ids),
 * returns id→order pairs. Ignores ids not in the owned set (caller passes
 * only owned ids). Deterministic and gap-free so ordering never drifts.
 */
export function normalizeDisplayOrder(orderedIds: string[]): { id: string; displayOrder: number }[] {
  return orderedIds.map((id, index) => ({ id, displayOrder: index }));
}

export type CleanupCandidate = {
  id: string;
  status: PortfolioModerationStatus;
  deletedAt: Date | null;
  rejectedAt: Date | null;
  removedAt: Date | null;
  uploadedAt: Date | null;
  submittedAt: Date | null;
  createdAt: Date;
};

export type CleanupConfig = {
  orphanStaleMs: number;   // UPLOADING/DRAFT that never finalized
  rejectedRetentionMs: number; // keep rejected for appeal, then delete
  removedRetentionMs: number;  // removed approved media retention
};

export const DEFAULT_CLEANUP_CONFIG: CleanupConfig = {
  orphanStaleMs: 24 * 60 * 60 * 1000,      // 24h
  rejectedRetentionMs: 30 * 24 * 60 * 60 * 1000, // 30d appeal window
  removedRetentionMs: 30 * 24 * 60 * 60 * 1000,  // 30d
};

/**
 * Decide whether a media object's STORAGE should be deleted now. Pure —
 * the job passes rows + now + config, this returns the subset whose
 * physical objects should be removed, with a reason. Note: "removed"
 * approved media stops being publicly deliverable IMMEDIATELY (enforced
 * by isPubliclyVisible), independent of when its storage is physically
 * cleaned — this function only governs physical deletion timing.
 */
export function cleanupReason(m: CleanupCandidate, now: Date, cfg: CleanupConfig = DEFAULT_CLEANUP_CONFIG): "orphan" | "deleted" | "rejected-expired" | "removed-expired" | null {
  // Hard-deleted by owner/account deletion → delete storage.
  if (m.deletedAt) return "deleted";
  // Never-finalized upload past the stale window.
  if ((m.status === "UPLOADING" || m.status === "DRAFT") && !m.uploadedAt) {
    if (now.getTime() - m.createdAt.getTime() > cfg.orphanStaleMs) return "orphan";
  }
  // Rejected past appeal retention.
  if (m.status === "REJECTED" && m.rejectedAt) {
    if (now.getTime() - m.rejectedAt.getTime() > cfg.rejectedRetentionMs) return "rejected-expired";
  }
  // Removed (was public) past retention.
  if (m.status === "REMOVED" && m.removedAt) {
    if (now.getTime() - m.removedAt.getTime() > cfg.removedRetentionMs) return "removed-expired";
  }
  return null;
}

export function selectCleanupTargets(rows: CleanupCandidate[], now: Date, cfg: CleanupConfig = DEFAULT_CLEANUP_CONFIG): { id: string; reason: string }[] {
  const out: { id: string; reason: string }[] = [];
  for (const m of rows) {
    const reason = cleanupReason(m, now, cfg);
    if (reason) out.push({ id: m.id, reason });
  }
  return out;
}
