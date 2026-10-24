import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";

type DbClient = typeof prisma | Prisma.TransactionClient;

/**
 * Recalculates a worker's public rating fields from scratch, from
 * PUBLISHED reviews only. Called after every review submission and every
 * moderation action (hide/restore/remove) — never computed once and left
 * to drift, and never includes HIDDEN/REMOVED reviews in either the
 * average or the five-star count that feeds the bonus generator.
 */
export async function recalculateWorkerRating(db: DbClient, workerId: string) {
  const aggregate = await db.review.aggregate({
    where: { workerId, status: "PUBLISHED" },
    _avg: { rating: true },
    _count: { rating: true },
  });

  // Distinct paid five-star jobs, not just five-star review rows — a
  // worker can only have one review per job (unique[jobId, workerId]) so
  // this is naturally already distinct per job, but the paymentStatus
  // check on the related job is what excludes a five-star review on a job
  // whose payment was never actually captured.
  const fiveStarReviewCount = await db.review.count({
    where: { workerId, status: "PUBLISHED", rating: 5, job: { status: "COMPLETED", paymentStatus: "CAPTURED" } },
  });

  return db.workerProfile.update({
    where: { id: workerId },
    data: {
      ratingAverage: aggregate._avg.rating ?? 0,
      ratingCount: aggregate._count.rating,
      fiveStarReviewCount,
    },
  });
}
