import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";

/**
 * Manual admin correction tool for completedJobs/firstCompletedJobAt.
 *
 * This used to be completely unauthenticated — anyone could POST here for
 * any workerId and manipulate their completedJobs count and first-job
 * waiver eligibility directly, which feeds into subscription billing and
 * bonus qualification. It's also no longer part of any normal workflow:
 * the actual, safe place these fields advance now is inside
 * POST /api/assignments/[assignmentId]/approve (moving jobs) and
 * POST /api/loads/[loadId]/status (freight, on SETTLED) — both
 * authenticated, transactional, and tied to real completed+approved work.
 *
 * This endpoint stays only as an admin-only manual override (e.g.
 * correcting a miscount), never a step in a normal flow.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ workerId: string }> },
) {
  let authed;
  try {
    authed = await requireRole(request, ["ADMIN"]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }

  const { workerId } = await context.params;
  const current = await prisma.workerProfile.findUnique({
    where: { id: workerId },
    select: { completedJobs: true, firstCompletedJobAt: true },
  });
  if (!current) return NextResponse.json({ error: "Worker not found." }, { status: 404 });

  const firstCompletedJobAt = current.firstCompletedJobAt ?? new Date();
  const worker = await prisma.workerProfile.update({
    where: { id: workerId },
    data: {
      completedJobs: { increment: 1 },
      firstCompletedJobAt,
    },
    select: {
      id: true,
      completedJobs: true,
      firstCompletedJobAt: true,
      subscriptionStatus: true,
    },
  });

  await prisma.auditLog.create({
    data: { actorId: authed.userId, action: "WORKER_JOB_COUNT_MANUALLY_ADJUSTED", entityType: "WorkerProfile", entityId: workerId, details: { newCompletedJobs: worker.completedJobs } },
  });

  return NextResponse.json({
    worker,
    subscriptionNowRequired: true,
    subscriptionAmountCents: 1995,
  });
}
