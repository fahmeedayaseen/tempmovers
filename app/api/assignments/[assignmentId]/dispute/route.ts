import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";
import { captureIntegrationAlert } from "@/lib/monitoring";

/**
 * Customer flags a checked-out assignment's hours as disputed —
 * completes the Approve/Dispute pair alongside the existing approve
 * route. Deliberately does NOT change Assignment.status: leaving it at
 * CHECKED_OUT (rather than inventing a new status) means it structurally
 * cannot satisfy the approve route's own precondition and cannot create
 * a Payout, cannot let the job reach COMPLETED, and cannot become
 * captureable — a disputed assignment is blocked by the same mechanism
 * that already blocks an unapproved one, not a new, separate one that
 * would need its own enforcement everywhere those checks happen.
 * Records the dispute and alerts an admin for manual resolution — no
 * automated resolution path exists, and none should: hours disputes
 * need a human to look at what actually happened.
 */
const schema = z.object({ reason: z.string().trim().min(1).max(2000) });

export async function POST(request: Request, context: { params: Promise<{ assignmentId: string }> }) {
  let authed;
  try {
    authed = await requireRole(request, ["CUSTOMER", "ADMIN"]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  const { assignmentId } = await context.params;

  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const assignment = await prisma.assignment.findUnique({
    where: { id: assignmentId },
    include: { job: { include: { customer: true } }, worker: true },
  });
  if (!assignment) return NextResponse.json({ error: "Assignment not found." }, { status: 404 });
  if (authed.role === "CUSTOMER" && assignment.job.customer.userId !== authed.userId) {
    return NextResponse.json({ error: "Not your job." }, { status: 403 });
  }
  if (assignment.status !== "CHECKED_OUT") {
    return NextResponse.json({ error: "Only a checked-out assignment awaiting approval can be disputed." }, { status: 409 });
  }

  const updated = await prisma.assignment.update({
    where: { id: assignmentId },
    data: { disputedAt: new Date(), disputeReason: parsed.data.reason },
  });

  await prisma.auditLog.create({
    data: { actorId: authed.userId, action: "ASSIGNMENT_DISPUTED", entityType: "Assignment", entityId: assignmentId, details: { reason: parsed.data.reason } },
  });

  captureIntegrationAlert("A customer disputed an assignment's hours — needs manual review.", {
    area: "payment", assignmentId, jobId: assignment.jobId, workerId: assignment.workerId, reason: parsed.data.reason,
  });

  return NextResponse.json({ assignment: updated });
}
