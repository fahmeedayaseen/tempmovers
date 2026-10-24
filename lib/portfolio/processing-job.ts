/**
 * Phase 5.5B — durable image-processing job.
 *
 * ⚠️ CODE COMPLETE / VALIDATION PENDING — runs sharp against real objects.
 *
 * P0-03 fix: image processing does NOT run in the request lifetime. Finalize
 * only marks a row processingStatus=PENDING. This job claims PENDING rows,
 * transitions them PROCESSING → PROCESSED/FAILED, and persists results. It's
 * invoked by scripts/portfolio-process.ts, standing in for a real queue/cron
 * (wiring to one is infra work). The claim uses an updateMany guard so two
 * concurrent runners can't process the same row twice.
 */
import { prisma } from "@/lib/db";
import { processPortfolioImage } from "@/lib/portfolio/image-processing";
import { selectRecoveryActions, MAX_PROCESSING_ATTEMPTS, PROCESSING_TIMEOUT_MS, type StaleCandidate } from "@/lib/portfolio/recovery";

export type ProcessBatchOutcome = { claimed: number; processed: number; failed: number };

const MAX_ATTEMPTS_NOTE = "Retried items stay FAILED; a human/retry policy decides re-queue.";

/**
 * Process up to `limit` pending items. Each item is atomically claimed
 * (PENDING → PROCESSING, guarded) before its bytes are touched, so a second
 * concurrent runner skips it. On success the row gets verified dimensions +
 * thumbnailKey and processingStatus=PROCESSED. On failure it becomes
 * processingStatus=FAILED with the reason recorded (and, for a hard safety
 * failure like a bad signature or bomb, the media is also rejected +
 * soft-deleted so its object is cleaned up).
 */
export async function runProcessingBatch(limit = 20): Promise<ProcessBatchOutcome> {
  const pending = await prisma.portfolioMedia.findMany({
    where: { processingStatus: "PENDING", deletedAt: null },
    take: limit,
    select: { id: true, storageKey: true, mimeType: true },
  });

  const outcome: ProcessBatchOutcome = { claimed: 0, processed: 0, failed: 0 };

  for (const item of pending) {
    // Atomic claim: only proceed if this runner flips PENDING → PROCESSING.
    // Also stamps recovery fields (started time, attempt counter) so a stale
    // job whose worker dies can be detected and recovered later.
    const claim = await prisma.portfolioMedia.updateMany({
      where: { id: item.id, processingStatus: "PENDING" },
      data: { processingStatus: "PROCESSING", processingStartedAt: new Date(), lastProcessingAttemptAt: new Date(), processingAttempts: { increment: 1 } },
    });
    if (claim.count === 0) continue; // another runner got it
    outcome.claimed++;

    let result;
    try {
      result = await processPortfolioImage({ storageKey: item.storageKey, declaredMime: item.mimeType });
    } catch (e) {
      result = { ok: false as const, reason: e instanceof Error ? e.message : "Processing crashed." };
    }

    if (result.ok) {
      await prisma.portfolioMedia.update({
        where: { id: item.id },
        data: { processingStatus: "PROCESSED", processedAt: new Date(), width: result.width, height: result.height, thumbnailKey: result.thumbnailKey, processingError: null },
      });
      await prisma.auditLog.create({ data: { action: "PORTFOLIO_PROCESSED", entityType: "PortfolioMedia", entityId: item.id, details: { thumbnail: Boolean(result.thumbnailKey) } } });
      outcome.processed++;
    } else {
      // Distinguish a SAFETY failure (reject + soft-delete the media) from a
      // transient one (just FAILED, retryable). Signature/bomb/decode/size
      // reasons are safety failures.
      const safetyFailure = /match an accepted image type|decompression|decoded|pixel|size is outside|no longer exists/i.test(result.reason);
      await prisma.portfolioMedia.update({
        where: { id: item.id },
        data: safetyFailure
          ? { processingStatus: "FAILED", processingError: result.reason, status: "REJECTED", rejectionReason: "This image did not pass automated safety checks.", deletedAt: new Date() }
          : { processingStatus: "FAILED", processingError: result.reason },
      });
      await prisma.auditLog.create({ data: { action: "PORTFOLIO_PROCESS_FAILED", entityType: "PortfolioMedia", entityId: item.id, details: { reason: result.reason, safetyFailure } } });
      outcome.failed++;
    }
  }

  return outcome;
}

export { MAX_ATTEMPTS_NOTE };

export type RecoveryOutcome = { scanned: number; retried: number; failed: number };

/**
 * Stale-worker recovery pass (P-rec). Finds rows stuck in PROCESSING past
 * the timeout — their claiming worker presumably died — and either returns
 * them to PENDING for another attempt (if attempts remain) or marks them
 * FAILED. The decision is the PURE selectRecoveryActions; this is the DB
 * orchestration. Each transition is guarded (still-PROCESSING) so it can't
 * race a worker that's actually still alive and about to finish.
 *
 * Intended to run on a schedule alongside runProcessingBatch. Wiring both
 * to a real recurring executor is the remaining infra step.
 */
export async function runProcessingRecovery(now: Date = new Date(), timeoutMs = PROCESSING_TIMEOUT_MS, maxAttempts = MAX_PROCESSING_ATTEMPTS): Promise<RecoveryOutcome> {
  const stuck = await prisma.portfolioMedia.findMany({
    where: { processingStatus: "PROCESSING", deletedAt: null },
    select: { id: true, processingStatus: true, processingStartedAt: true, processingAttempts: true },
  });
  const candidates: StaleCandidate[] = stuck.map(s => ({ id: s.id, processingStatus: s.processingStatus, processingStartedAt: s.processingStartedAt, processingAttempts: s.processingAttempts }));
  const actions = selectRecoveryActions(candidates, now, timeoutMs, maxAttempts);

  const outcome: RecoveryOutcome = { scanned: candidates.length, retried: 0, failed: 0 };
  for (const a of actions) {
    if (a.action === "retry") {
      // Guarded: only if still PROCESSING (didn't just complete).
      const r = await prisma.portfolioMedia.updateMany({
        where: { id: a.id, processingStatus: "PROCESSING" },
        data: { processingStatus: "PENDING", processingStartedAt: null, processingError: "Recovered after stale/abandoned processing." },
      });
      if (r.count > 0) { outcome.retried++; await prisma.auditLog.create({ data: { action: "PORTFOLIO_PROCESS_RECOVERED", entityType: "PortfolioMedia", entityId: a.id, details: { action: "retry" } } }); }
    } else {
      const r = await prisma.portfolioMedia.updateMany({
        where: { id: a.id, processingStatus: "PROCESSING" },
        data: { processingStatus: "FAILED", processingError: "Processing did not complete after maximum attempts." },
      });
      if (r.count > 0) { outcome.failed++; await prisma.auditLog.create({ data: { action: "PORTFOLIO_PROCESS_RECOVERED", entityType: "PortfolioMedia", entityId: a.id, details: { action: "fail" } } }); }
    }
  }
  return outcome;
}
