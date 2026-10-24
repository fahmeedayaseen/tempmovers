import { prisma } from "@/lib/db";
import { recalculateWorkerRating } from "@/lib/reviews";

/**
 * HIDDEN and REMOVED must both immediately fall out of the worker's public
 * rating and bonus qualification — recalculateWorkerRating only ever
 * counts PUBLISHED reviews, so calling it right after the status change is
 * what actually enforces that, not just the status field existing.
 */
export async function moderateReview({
  reviewId, status, moderatedBy, reason,
}: { reviewId: string; status: "PUBLISHED" | "HIDDEN" | "REMOVED"; moderatedBy: string; reason?: string }) {
  const review = await prisma.review.findUnique({ where: { id: reviewId } });
  if (!review) return null;

  const updated = await prisma.$transaction(async (tx) => {
    const result = await tx.review.update({
      where: { id: reviewId },
      data: { status, moderatedAt: new Date(), moderatedBy, ...(reason && { reportReason: reason }) },
    });
    await recalculateWorkerRating(tx, review.workerId);
    await tx.auditLog.create({
      data: { actorId: moderatedBy, action: `REVIEW_${status}`, entityType: "Review", entityId: reviewId, details: { reason: reason ?? null } },
    });
    return result;
  });

  return updated;
}
