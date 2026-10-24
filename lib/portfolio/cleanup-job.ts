/**
 * Phase 5.5B — cleanup / retention / deletion job logic.
 *
 * ⚠️ CODE COMPLETE / VALIDATION PENDING — physical deletes hit real S3.
 *
 * The ELIGIBILITY decisions come from the PURE selectCleanupTargets in
 * lib/portfolio/cleanup.ts (fully unit-tested). This module is the
 * DB + storage orchestration around them: load candidate rows, ask the
 * pure layer what to delete, delete objects idempotently, and record the
 * outcome. Deletes are retry-safe (deleteObject swallows missing-object)
 * so a partially-failed batch can be re-run without harm.
 *
 * These functions are invoked by the scripts in scripts/portfolio-*.ts,
 * which stand in for a scheduler this codebase does not yet have. Wiring
 * them to a real cron/queue is part of 5.5B infrastructure work.
 */
import { prisma } from "@/lib/db";
import { deleteObject, buildThumbnailKey } from "@/lib/storage";
import { selectCleanupTargets, DEFAULT_CLEANUP_CONFIG, type CleanupConfig, type CleanupCandidate } from "@/lib/portfolio/cleanup";

export type CleanupOutcome = { scanned: number; deleted: number; failed: number; reasons: Record<string, number> };

/**
 * One cleanup pass. Loads candidate media (anything not already fully
 * gone), asks the pure layer which to physically delete, removes each
 * object + its thumbnail idempotently, and hard-deletes the DB row only
 * after its storage is gone. A per-item storage failure is counted and
 * skipped, never aborts the batch.
 *
 * Preserves audit records: the PortfolioMedia row is removed, but the
 * AuditLog entries referencing it (by entityId string, not FK) remain.
 */
export async function runPortfolioCleanup(now: Date = new Date(), cfg: CleanupConfig = DEFAULT_CLEANUP_CONFIG): Promise<CleanupOutcome> {
  // Candidates: soft-deleted, rejected, removed, or never-finalized uploads.
  const rows = await prisma.portfolioMedia.findMany({
    where: {
      OR: [
        { deletedAt: { not: null } },
        { status: "REJECTED" },
        { status: "REMOVED" },
        { status: { in: ["UPLOADING", "DRAFT"] } },
      ],
    },
    select: { id: true, status: true, deletedAt: true, rejectedAt: true, removedAt: true, uploadedAt: true, submittedAt: true, createdAt: true, storageKey: true, thumbnailKey: true },
  });

  const candidates: CleanupCandidate[] = rows.map(r => ({
    id: r.id, status: r.status, deletedAt: r.deletedAt, rejectedAt: r.rejectedAt, removedAt: r.removedAt, uploadedAt: r.uploadedAt, submittedAt: r.submittedAt, createdAt: r.createdAt,
  }));
  const targets = selectCleanupTargets(candidates, now, cfg);
  const keyById = new Map(rows.map(r => [r.id, r]));

  const outcome: CleanupOutcome = { scanned: candidates.length, deleted: 0, failed: 0, reasons: {} };

  for (const t of targets) {
    const row = keyById.get(t.id);
    if (!row) continue;
    try {
      await deleteObject(row.storageKey);
      await deleteObject(row.thumbnailKey ?? buildThumbnailKey(row.storageKey));
      await prisma.portfolioMedia.delete({ where: { id: t.id } });
      outcome.deleted++;
      outcome.reasons[t.reason] = (outcome.reasons[t.reason] ?? 0) + 1;
    } catch {
      // Storage or DB failure for this item — count and continue. Re-running
      // the job will retry it (deleteObject is idempotent).
      outcome.failed++;
    }
  }

  return outcome;
}

/**
 * Account-deletion cleanup: queue every portfolio object owned by a worker
 * for deletion. Called from the account-deletion flow. Idempotent and
 * retry-safe. Preserves non-media audit records (AuditLog rows are not
 * touched here).
 */
export async function purgeWorkerPortfolio(workerId: string): Promise<CleanupOutcome> {
  const rows = await prisma.portfolioMedia.findMany({ where: { workerId }, select: { id: true, storageKey: true, thumbnailKey: true } });
  const outcome: CleanupOutcome = { scanned: rows.length, deleted: 0, failed: 0, reasons: { "account-deletion": 0 } };
  for (const r of rows) {
    try {
      await deleteObject(r.storageKey);
      await deleteObject(r.thumbnailKey ?? buildThumbnailKey(r.storageKey));
      await prisma.portfolioMedia.delete({ where: { id: r.id } });
      outcome.deleted++;
      outcome.reasons["account-deletion"]++;
    } catch {
      outcome.failed++;
    }
  }
  return outcome;
}
