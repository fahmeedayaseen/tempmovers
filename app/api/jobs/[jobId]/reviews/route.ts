import { NextResponse } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";
import { recalculateWorkerRating } from "@/lib/reviews";
import { generateThreeFiveStarBonus } from "@/lib/bonus-generators";

const reviewSchema = z.object({
  workerId: z.string(),
  rating: z.number().int().min(1).max(5),
  comment: z.string().trim().max(1000).optional(),
  tags: z.array(z.enum(["PUNCTUAL", "PROFESSIONAL", "CAREFUL", "FRIENDLY", "EFFICIENT", "GOOD_COMMUNICATION"])).max(6).default([]),
});

/** Lists the workers this customer can review on this job — a job must be
 *  COMPLETED and CAPTURED, and only APPROVED assignments are reviewable
 *  (a worker who never actually did approved work has nothing to review). */
export async function GET(request: Request, context: { params: Promise<{ jobId: string }> }) {
  let authed;
  try {
    authed = await requireRole(request, ["CUSTOMER"]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  const { jobId } = await context.params;

  const customer = await prisma.customerProfile.findUnique({ where: { userId: authed.userId } });
  if (!customer) return NextResponse.json({ error: "Customer profile not found." }, { status: 404 });

  const job = await prisma.job.findFirst({
    where: { id: jobId, customerId: customer.id, status: "COMPLETED", paymentStatus: "CAPTURED" },
    include: {
      assignments: { where: { status: "APPROVED" }, include: { worker: { include: { user: true } } } },
      reviews: true,
    },
  });
  if (!job) return NextResponse.json({ error: "This job is not eligible for review." }, { status: 403 });

  const reviewedWorkerIds = new Set(job.reviews.map((r) => r.workerId));

  return NextResponse.json({
    workers: job.assignments.map((a) => ({
      id: a.worker.id,
      displayName: a.worker.displayName ?? `${a.worker.user.firstName} ${a.worker.user.lastName}`,
      profilePhotoUrl: a.worker.profilePhotoUrl,
      alreadyReviewed: reviewedWorkerIds.has(a.worker.id),
    })),
  });
}

export async function POST(request: Request, context: { params: Promise<{ jobId: string }> }) {
  let authed;
  try {
    authed = await requireRole(request, ["CUSTOMER"]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  const { jobId } = await context.params;

  const parsed = reviewSchema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: "Invalid review.", details: parsed.error.flatten() }, { status: 400 });

  const customer = await prisma.customerProfile.findUnique({ where: { userId: authed.userId } });
  if (!customer) return NextResponse.json({ error: "Customer profile not found." }, { status: 404 });

  // Ownership, job status, payment status, and "was this worker actually
  // an approved assignment on this job" are all checked in one query —
  // any mismatch (wrong customer, wrong worker, job not done/paid) fails
  // closed with the same 403 rather than leaking which specific check failed.
  const job = await prisma.job.findFirst({
    where: {
      id: jobId, customerId: customer.id, status: "COMPLETED", paymentStatus: "CAPTURED",
      assignments: { some: { workerId: parsed.data.workerId, status: "APPROVED" } },
    },
    select: { id: true },
  });
  if (!job) return NextResponse.json({ error: "This job or worker is not eligible for review." }, { status: 403 });

  let review;
  try {
    review = await prisma.$transaction(async (tx) => {
      const created = await tx.review.create({
        data: {
          jobId: job.id, workerId: parsed.data.workerId, customerId: customer.id,
          rating: parsed.data.rating, comment: parsed.data.comment, tags: parsed.data.tags,
          status: "PUBLISHED",
        },
      });
      await recalculateWorkerRating(tx, parsed.data.workerId);
      await tx.auditLog.create({
        data: { actorId: authed.userId, action: "CUSTOMER_REVIEW_CREATED", entityType: "Review", entityId: created.id, details: { jobId: job.id, workerId: parsed.data.workerId, rating: parsed.data.rating } },
      });
      return created;
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return NextResponse.json({ error: "You already reviewed this worker for this job." }, { status: 409 });
    }
    throw error;
  }

  // Five-star bonus qualification happens after the review transaction
  // commits, not inside it — the generator has its own idempotency
  // (BonusAward unique constraint) and shouldn't hold the review-creation
  // transaction open any longer than necessary.
  if (review.rating === 5) {
    await generateThreeFiveStarBonus(prisma, parsed.data.workerId);
  }

  return NextResponse.json({ review }, { status: 201 });
}
