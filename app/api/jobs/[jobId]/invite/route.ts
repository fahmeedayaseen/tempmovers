import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";
import { queueNotification } from "@/lib/notifications";
import { jobInvitationTemplate } from "@/lib/email/templates/booking";

/**
 * A customer invites a specific worker to their job — uses
 * AssignmentStatus.INVITED, per the explicit business rule, rather than
 * a separate invitation table (moving jobs don't have an equivalent of
 * CarrierRouteInvitation, and Assignment already models "this worker's
 * relationship to this job" for every other state, so INVITED is just
 * one more state of that same relationship, not a new concept).
 *
 * Pricing is never computed separately here — job.customerMoverRateCents
 * is the same field the open-marketplace self-apply flow uses, so an
 * invited worker is never offered a different rate than the platform's
 * own posted rate for this job.
 *
 * Default expiration window is 2 hours, per the recommended default in
 * the business rules — configurable via an optional request field
 * rather than hardcoded, so this doesn't need a code change if that
 * default is revisited later.
 */
const DEFAULT_EXPIRATION_HOURS = 2;
const schema = z.object({ workerId: z.string().cuid(), expirationHours: z.number().min(0.25).max(72).optional() });

export async function POST(request: Request, context: { params: Promise<{ jobId: string }> }) {
  let authed;
  try {
    authed = await requireRole(request, ["CUSTOMER", "ADMIN"]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  const { jobId } = await context.params;

  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const job = await prisma.job.findUnique({ where: { id: jobId }, include: { customer: true } });
  if (!job) return NextResponse.json({ error: "Job not found." }, { status: 404 });
  if (authed.role === "CUSTOMER" && job.customer.userId !== authed.userId) {
    return NextResponse.json({ error: "Not your job." }, { status: 403 });
  }
  if (!["POSTED", "MATCHING", "PARTIALLY_FILLED"].includes(job.status)) {
    return NextResponse.json({ error: "Job is not accepting workers." }, { status: 409 });
  }

  const worker = await prisma.workerProfile.findUnique({ where: { id: parsed.data.workerId } });
  if (!worker) return NextResponse.json({ error: "Worker not found." }, { status: 404 });
  if (worker.workerType !== "MOVER") {
    return NextResponse.json({ error: "Only mover accounts can be invited to moving jobs." }, { status: 400 });
  }
  if (worker.operationalStatus !== "ACTIVE") {
    return NextResponse.json({ error: "This worker's account is not currently active." }, { status: 409 });
  }

  const expiresAt = new Date(Date.now() + (parsed.data.expirationHours ?? DEFAULT_EXPIRATION_HOURS) * 60 * 60 * 1000);

  // upsert rather than create — re-inviting the same worker to the same
  // job (e.g. after a prior invitation expired) updates the existing row
  // instead of colliding with the @@unique([jobId, workerId]) constraint.
  const assignment = await prisma.assignment.upsert({
    where: { jobId_workerId: { jobId, workerId: worker.id } },
    update: { status: "INVITED", expiresAt, respondedAt: null },
    create: {
      jobId, workerId: worker.id, status: "INVITED",
      agreedEarningsCents: job.customerMoverRateCents,
      scheduledHours: job.estimatedHours,
      expiresAt,
    },
  });

  await prisma.auditLog.create({
    data: { actorId: authed.userId, action: "JOB_INVITATION_SENT", entityType: "Assignment", entityId: assignment.id, details: { jobId, workerId: worker.id, expiresAt } },
  });

  const notice = jobInvitationTemplate({ workerName: worker.displayName ?? "there", jobTitle: job.title, scheduledStart: job.startsAt, expiresAt });
  await queueNotification({
    userId: worker.userId, type: "JOB_INVITATION", channels: ["EMAIL", "IN_APP"],
    title: notice.subject, body: notice.text, html: notice.html, idempotencyKey: `job-invitation:${assignment.id}:${assignment.expiresAt?.toISOString()}`,
  });

  return NextResponse.json({ assignment }, { status: 201 });
}
