import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";
import { queueNotification } from "@/lib/notifications";
import { invitationResponseTemplate } from "@/lib/email/templates/booking";

export async function POST(request: Request, context: { params: Promise<{ assignmentId: string }> }) {
  let authed;
  try {
    authed = await requireRole(request, ["MOVER"]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  const { assignmentId } = await context.params;

  const worker = await prisma.workerProfile.findUnique({ where: { userId: authed.userId } });
  if (!worker) return NextResponse.json({ error: "Worker profile not found." }, { status: 404 });

  const assignment = await prisma.assignment.findUnique({ where: { id: assignmentId } });
  if (!assignment) return NextResponse.json({ error: "Invitation not found." }, { status: 404 });
  if (assignment.workerId !== worker.id) return NextResponse.json({ error: "This invitation is not yours." }, { status: 403 });
  if (assignment.status !== "INVITED") {
    return NextResponse.json({ error: `This invitation is ${assignment.status.toLowerCase()} and can no longer be declined.` }, { status: 409 });
  }

  const claim = await prisma.assignment.updateMany({
    where: { id: assignmentId, status: "INVITED" },
    data: { status: "DECLINED", respondedAt: new Date() },
  });
  if (claim.count !== 1) return NextResponse.json({ error: "This invitation was already responded to." }, { status: 409 });

  await prisma.auditLog.create({
    data: { actorId: authed.userId, action: "JOB_INVITATION_DECLINED", entityType: "Assignment", entityId: assignmentId, details: { jobId: assignment.jobId } },
  });

  const jobWithCustomer = await prisma.job.findUnique({ where: { id: assignment.jobId }, include: { customer: { include: { user: true } } } });
  if (jobWithCustomer) {
    const notice = invitationResponseTemplate({ customerName: jobWithCustomer.customer.user.firstName, workerName: worker.displayName ?? "A worker", entityTitle: jobWithCustomer.title, accepted: false });
    await queueNotification({
      userId: jobWithCustomer.customer.userId, type: "INVITATION_RESPONSE", channels: ["EMAIL", "IN_APP"],
      title: notice.subject, body: notice.text, html: notice.html, idempotencyKey: `invitation-response:${assignmentId}:DECLINED`,
    });
  }

  const updated = await prisma.assignment.findUnique({ where: { id: assignmentId } });
  return NextResponse.json({ assignment: updated });
}
