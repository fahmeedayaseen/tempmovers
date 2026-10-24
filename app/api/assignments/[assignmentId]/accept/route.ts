import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";
import { workerCanServeLocation } from "@/lib/geo";
import { evaluateWorkerEligibility } from "@/lib/worker-eligibility";
import { checkOpportunityAccess } from "@/lib/access/opportunity-access";
import { queueNotification } from "@/lib/notifications";
import { invitationResponseTemplate } from "@/lib/email/templates/booking";

/**
 * A worker accepts a job invitation — same eligibility bar as the
 * open-marketplace self-apply flow (onboarding, compliance, geo),
 * since an invited worker should never be held to a LOWER standard
 * than a self-applying one. The one thing genuinely specific to
 * invitations: expiration, and the atomic slot check the business
 * rules require ("invitation acceptance must respect remaining worker
 * slots" — an invited worker accepting after the job already filled up
 * through other invitations/self-applications must be rejected
 * cleanly, not silently over-fill the crew).
 */
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

  const assignment = await prisma.assignment.findUnique({ where: { id: assignmentId }, include: { job: true } });
  if (!assignment) return NextResponse.json({ error: "Invitation not found." }, { status: 404 });
  if (assignment.workerId !== worker.id) return NextResponse.json({ error: "This invitation is not yours." }, { status: 403 });
  if (assignment.status !== "INVITED") return NextResponse.json({ error: `This invitation is ${assignment.status.toLowerCase()} and can no longer be accepted.` }, { status: 409 });
  if (assignment.expiresAt && assignment.expiresAt < new Date()) {
    return NextResponse.json({ error: "This invitation has expired." }, { status: 409 });
  }

  const evaluation = await evaluateWorkerEligibility({ workerId: worker.id, context: "MOVING_JOB_ACCEPTANCE" });
  if (!evaluation.allowed) {
    return NextResponse.json({ error: "Onboarding must be complete before accepting jobs.", missing: evaluation.missingRequirements }, { status: 403 });
  }
  const access = await checkOpportunityAccess(worker.id, { assignedWorkerId: null }, "ACCEPT");
  if (!access.allowed) {
    return NextResponse.json({ error: "Complete screening and compliance approval before accepting jobs.", reasonCode: access.reasonCode, missing: access.missingRequirements }, { status: 403 });
  }

  const [workerMarkets, workerTerritories] = await Promise.all([
    prisma.workerMarket.findMany({ where: { workerId: worker.id, active: true } }),
    prisma.workerTerritory.findMany({ where: { workerId: worker.id, active: true } }),
  ]);
  const marketMembership = workerMarkets.find((wm) => wm.marketId === assignment.job.marketId);
  const eligible = workerCanServeLocation({
    workerMarketIds: workerMarkets.map((wm) => wm.marketId),
    workerTerritoryIds: workerTerritories.map((wt) => wt.territoryId),
    homeLatitude: marketMembership?.homeLatitude ? Number(marketMembership.homeLatitude) : null,
    homeLongitude: marketMembership?.homeLongitude ? Number(marketMembership.homeLongitude) : null,
    serviceRadiusMiles: marketMembership?.serviceRadiusMiles ?? null,
    jobMarketId: assignment.job.marketId,
    jobTerritoryId: assignment.job.territoryId,
    jobLatitude: assignment.job.latitude ? Number(assignment.job.latitude) : null,
    jobLongitude: assignment.job.longitude ? Number(assignment.job.longitude) : null,
  });
  if (!eligible) return NextResponse.json({ error: "This job is outside your active market or service area." }, { status: 403 });

  // Atomic: re-check the WHERE clause (still INVITED) at the moment of
  // the update, inside a transaction with the slot count, so a race
  // between this acceptance and the crew filling up through other
  // means can't over-fill it.
  try {
    const result = await prisma.$transaction(async (tx) => {
      const filledCount = await tx.assignment.count({
        where: { jobId: assignment.jobId, status: { in: ["ACCEPTED", "CHECKED_IN", "CHECKED_OUT", "APPROVED"] } },
      });
      if (filledCount >= assignment.job.moversRequired) {
        throw new Error("JOB_ALREADY_FULLY_STAFFED");
      }
      const claim = await tx.assignment.updateMany({
        where: { id: assignmentId, status: "INVITED" },
        data: { status: "ACCEPTED", respondedAt: new Date() },
      });
      if (claim.count !== 1) throw new Error("INVITATION_ALREADY_RESOLVED");

      const newFilledCount = filledCount + 1;
      await tx.job.update({
        where: { id: assignment.jobId },
        data: { status: newFilledCount >= assignment.job.moversRequired ? "CONFIRMED" : "PARTIALLY_FILLED" },
      });
      return await tx.assignment.findUniqueOrThrow({ where: { id: assignmentId } });
    });

    const jobWithCustomer = await prisma.job.findUnique({ where: { id: assignment.jobId }, include: { customer: { include: { user: true } } } });
    if (jobWithCustomer) {
      const notice = invitationResponseTemplate({ customerName: jobWithCustomer.customer.user.firstName, workerName: worker.displayName ?? "A worker", entityTitle: jobWithCustomer.title, accepted: true });
      await queueNotification({
        userId: jobWithCustomer.customer.userId, type: "INVITATION_RESPONSE", channels: ["EMAIL", "IN_APP"],
        title: notice.subject, body: notice.text, html: notice.html, idempotencyKey: `invitation-response:${result.id}:ACCEPTED`,
      });
    }

    return NextResponse.json({ assignment: result });
  } catch (e) {
    if (e instanceof Error && e.message === "JOB_ALREADY_FULLY_STAFFED") {
      return NextResponse.json({ error: "This job's crew is already fully staffed." }, { status: 409 });
    }
    if (e instanceof Error && e.message === "INVITATION_ALREADY_RESOLVED") {
      return NextResponse.json({ error: "This invitation was already responded to." }, { status: 409 });
    }
    throw e;
  }
}
