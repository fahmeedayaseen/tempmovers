import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";

const schema = z.object({ reason: z.string().min(1).max(500) });

/**
 * Any worker or admin can report a review as inappropriate/inaccurate.
 * This only flags it (reportedAt/reportReason) for the admin moderation
 * queue — it does NOT change the review's status. A worker reporting a
 * review about themselves has no path to hide or remove it directly;
 * only POST /api/admin/reviews/[reviewId]/hide|remove can do that.
 */
export async function POST(request: Request, context: { params: Promise<{ reviewId: string }> }) {
  let authed;
  try {
    authed = await requireRole(request, ["MOVER", "DRIVER", "ADMIN"]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  const { reviewId } = await context.params;
  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const review = await prisma.review.findUnique({ where: { id: reviewId }, include: { worker: true } });
  if (!review) return NextResponse.json({ error: "Review not found." }, { status: 404 });
  if (authed.role !== "ADMIN" && review.worker.userId !== authed.userId) {
    return NextResponse.json({ error: "You can only report reviews about yourself." }, { status: 403 });
  }

  const updated = await prisma.review.update({
    where: { id: reviewId },
    data: { reportedAt: new Date(), reportReason: parsed.data.reason },
  });

  await prisma.auditLog.create({
    data: { actorId: authed.userId, action: "REVIEW_REPORTED", entityType: "Review", entityId: reviewId, details: { reason: parsed.data.reason } },
  });

  return NextResponse.json({ review: updated });
}
