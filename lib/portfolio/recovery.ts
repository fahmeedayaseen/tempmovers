/**
 * Phase 5.5B — PURE stale-worker recovery decisions. A worker claims a job
 * (PENDING → PROCESSING) then processes it; if that worker crashes, the row
 * is stuck in PROCESSING forever. This module decides, given a stuck row's
 * timing and attempt count, whether to RETRY it (back to PENDING) or give up
 * and mark it FAILED. No db — the recovery task supplies rows, this decides.
 */
import type { PortfolioProcessingStatus } from "@prisma/client";

export const PROCESSING_TIMEOUT_MS = 20 * 60 * 1000; // 20 min — a job older than this with no result is presumed dead
export const MAX_PROCESSING_ATTEMPTS = 3;             // after this many claims, stop retrying and FAIL

export type StaleCandidate = {
  id: string;
  processingStatus: PortfolioProcessingStatus;
  processingStartedAt: Date | null;
  processingAttempts: number;
};

export type RecoveryAction = "retry" | "fail" | "none";

/**
 * Decide what to do with a possibly-stuck row.
 *  - Only PROCESSING rows are candidates; anything else → "none".
 *  - Not yet past the timeout → "none" (still legitimately in flight).
 *  - Past the timeout, attempts remaining → "retry" (return to PENDING).
 *  - Past the timeout, attempts exhausted → "fail".
 */
export function recoveryAction(row: StaleCandidate, now: Date, timeoutMs = PROCESSING_TIMEOUT_MS, maxAttempts = MAX_PROCESSING_ATTEMPTS): RecoveryAction {
  if (row.processingStatus !== "PROCESSING") return "none";
  if (!row.processingStartedAt) {
    // PROCESSING with no start time is itself anomalous — treat as stuck.
    return row.processingAttempts >= maxAttempts ? "fail" : "retry";
  }
  const age = now.getTime() - row.processingStartedAt.getTime();
  if (age <= timeoutMs) return "none";
  return row.processingAttempts >= maxAttempts ? "fail" : "retry";
}

export function selectRecoveryActions(rows: StaleCandidate[], now: Date, timeoutMs = PROCESSING_TIMEOUT_MS, maxAttempts = MAX_PROCESSING_ATTEMPTS): { id: string; action: Exclude<RecoveryAction, "none"> }[] {
  const out: { id: string; action: Exclude<RecoveryAction, "none"> }[] = [];
  for (const r of rows) {
    const a = recoveryAction(r, now, timeoutMs, maxAttempts);
    if (a !== "none") out.push({ id: r.id, action: a });
  }
  return out;
}
