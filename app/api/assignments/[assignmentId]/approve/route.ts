import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";
import { MINIMUM_JOB_HOURS } from "@/lib/pricing";

/**
 * Customer (or admin, for disputes) approves the actual hours worked. This is
 * the gate that creates the Payout record — nothing gets paid out before
 * approval, and only for assignments that actually reached CHECKED_OUT (a
 * DECLINED/CANCELED/NO_SHOW assignment can never satisfy that precondition,
 * so it structurally can never receive a payout through this route — there
 * is no other code path that creates a Payout).
 *
 * The billed-hours floor (MINIMUM_JOB_HOURS) here MUST stay in sync with
 * app/api/jobs/[jobId]/capture-payment/route.ts's finalLaborCents
 * calculation — the customer is charged to cover exactly what workers are
 * paid, using the identical per-assignment formula, or the two silently
 * drift apart.
 *
 * Also owns the Job.status -> COMPLETED transition: previously nothing in
 * this codebase ever set that status, which meant capture-payment's own
 * precondition (job.status === "COMPLETED") could never actually be
 * satisfied by any code path. Fires here, once, only when this approval
 * was the last outstanding billable assignment for the job.
 */
export async function POST(request: Request, context: { params: Promise<{ assignmentId: string }> }) {
  let authed;
  try {
    authed = await requireRole(request, ["CUSTOMER", "ADMIN"]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  const { assignmentId } = await context.params;

  const assignment = await prisma.assignment.findUnique({
    where: { id: assignmentId },
    include: { job: { include: { customer: true } }, worker: true, payout: true },
  });
  if (!assignment) return NextResponse.json({ error: "Assignment not found." }, { status: 404 });
  if (authed.role === "CUSTOMER" && assignment.job.customer.userId !== authed.userId) {
    return NextResponse.json({ error: "Not your job." }, { status: 403 });
  }
  if (assignment.status !== "CHECKED_OUT" || assignment.actualHours === null) {
    return NextResponse.json({ error: "Assignment must be checked out before approval." }, { status: 409 });
  }
  if (assignment.payout) return NextResponse.json({ error: "Already approved and paid out." }, { status: 409 });

  const billedHours = Math.max(MINIMUM_JOB_HOURS, Number(assignment.actualHours));
  const grossEarningsCents = Math.round(assignment.agreedEarningsCents * billedHours);
  const isFirstCompletion = assignment.worker.completedJobs < 1 && !assignment.worker.firstCompletedJobAt;

  const [updatedAssignment, payout] = await prisma.$transaction([
    prisma.assignment.update({
      where: { id: assignmentId },
      data: { status: "APPROVED", customerApprovedAt: new Date() },
    }),
    prisma.payout.create({
      data: {
        workerId: assignment.workerId, assignmentId: assignment.id,
        grossEarningsCents, netPayoutCents: grossEarningsCents, status: "SCHEDULED",
      },
    }),
    // This is the actual, safe, authenticated place completedJobs advances
    // — not the standalone /complete-first-job endpoint, which had no auth
    // check at all and let anyone manipulate any worker's eligibility.
    prisma.workerProfile.update({
      where: { id: assignment.workerId },
      data: {
        completedJobs: { increment: 1 },
        ...(isFirstCompletion && { firstCompletedJobAt: new Date() }),
      },
    }),
  ]);

  await prisma.auditLog.create({
    data: { actorId: authed.userId, action: "ASSIGNMENT_APPROVED", entityType: "Assignment", entityId: assignmentId, details: { billedHours, grossEarningsCents } },
  });

  // If every billable assignment on this job (CHECKED_OUT or APPROVED —
  // never DECLINED/CANCELED/NO_SHOW, which never reach CHECKED_OUT in the
  // first place) is now APPROVED, the job is ready for final capture.
  // Checked fresh from the database rather than assumed, since another
  // assignment could still be sitting at CHECKED_OUT awaiting its own
  // separate approval.
  const remainingUnapproved = await prisma.assignment.count({
    where: { jobId: assignment.jobId, status: "CHECKED_OUT" },
  });
  let jobCompleted = false;
  if (remainingUnapproved === 0) {
    const updateResult = await prisma.job.updateMany({
      where: { id: assignment.jobId, status: { notIn: ["COMPLETED", "CANCELED", "DISPUTED"] } },
      data: { status: "COMPLETED" },
    });
    jobCompleted = updateResult.count > 0;
    if (jobCompleted) {
      await prisma.auditLog.create({
        data: { actorId: authed.userId, action: "JOB_COMPLETED", entityType: "Job", entityId: assignment.jobId, details: { triggeredByAssignmentId: assignmentId } },
      });
    }
  }

  return NextResponse.json({ assignment: updatedAssignment, payout, jobCompleted });
}
