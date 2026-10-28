import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";
import { workerCanServeLocation } from "@/lib/geo";
import { evaluateWorkerEligibility } from "@/lib/worker-eligibility";
import { checkOpportunityAccess } from "@/lib/access/opportunity-access";
import { queueNotification } from "@/lib/notifications";
import { assignmentNoticeTemplate } from "@/lib/email/templates/booking";
import { checkJobPostingModeAllowsSelfApply } from "@/lib/job-posting-mode";
import { canTakeJunkJobs, junkCrewRoleFor, junkSeats, JUNK_SEAT_HOLDING_STATUSES } from "@/lib/junk/crew";
import { Prisma, type Assignment } from "@prisma/client";

/**
 * Lists a job's assignments — for the customer-facing "Approve Hours"
 * UI, which needs to show each worker's checked-out hours before the
 * customer can approve or dispute them. Customer must own the job;
 * admin can view any job's assignments.
 */
export async function GET(request: Request, context: { params: Promise<{ jobId: string }> }) {
  let authed;
  try {
    authed = await requireRole(request, ["CUSTOMER", "ADMIN"]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  const { jobId } = await context.params;

  const job = await prisma.job.findUnique({ where: { id: jobId }, include: { customer: true } });
  if (!job) return NextResponse.json({ error: "Job not found." }, { status: 404 });
  if (authed.role === "CUSTOMER" && job.customer.userId !== authed.userId) {
    return NextResponse.json({ error: "Not your job." }, { status: 403 });
  }

  const assignments = await prisma.assignment.findMany({
    where: { jobId, status: { in: ["CHECKED_OUT", "APPROVED"] } },
    select: {
      id: true, status: true, scheduledHours: true, actualHours: true, checkInAt: true, checkOutAt: true, customerApprovedAt: true,
      worker: { select: { id: true, displayName: true } },
    },
    orderBy: { checkOutAt: "asc" },
  });

  return NextResponse.json({ assignments });
}

// A mover applies to (accepts) an open moving job. Applying more workers than
// moversRequired is allowed (customer/admin picks), but the job can't be
// short-crewed below the approved minimum at confirmation time — enforced
// in the confirm/assign step, not here.
//
// Junk removal — VASRUE Digital Media, 28 Oct 2026. The same route takes a seat on a junk
// crew. Junk is different in three ways: drivers are admitted (a box-truck
// driver or junk hauler fills the hauler seat), each seat is paid the flat
// share fixed at booking, and seats are capped — one hauler plus the helpers
// the booking called for — so the seat check and the insert run in one
// serializable transaction and two workers can never take the same seat.
export async function POST(request: Request, context: { params: Promise<{ jobId: string }> }) {
  let authed;
  try {
    authed = await requireRole(request, ["MOVER", "DRIVER"]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  const { jobId } = await context.params;

  const job = await prisma.job.findUnique({ where: { id: jobId } });
  if (!job) return NextResponse.json({ error: "Job not found." }, { status: 404 });
  if (!["POSTED", "MATCHING", "PARTIALLY_FILLED"].includes(job.status)) {
    return NextResponse.json({ error: "Job is not accepting workers." }, { status: 409 });
  }

  const worker = await prisma.workerProfile.findUnique({ where: { userId: authed.userId } });
  if (!worker) return NextResponse.json({ error: "Worker profile not found." }, { status: 404 });
  const isJunk = job.type === "JUNK_REMOVAL";
  const junkRole = isJunk ? junkCrewRoleFor(worker.workerType) : null;
  if (isJunk) {
    if (!junkRole) return NextResponse.json({ error: "This account type can't take junk removal jobs." }, { status: 403 });
    if (!canTakeJunkJobs(worker)) return NextResponse.json({ error: "Switch on junk removal jobs in your dashboard before taking one." }, { status: 403 });
  } else if (worker.workerType !== "MOVER") {
    return NextResponse.json({ error: "Only mover accounts can accept moving jobs." }, { status: 403 });
  }

  const postingModeCheck = await checkJobPostingModeAllowsSelfApply(job, worker.id);
  if (!postingModeCheck.allowed) {
    return NextResponse.json({ error: postingModeCheck.reason }, { status: 403 });
  }
  const evaluation = await evaluateWorkerEligibility({ workerId: worker.id, context: "MOVING_JOB_ACCEPTANCE" });
  if (!evaluation.allowed) {
    return NextResponse.json({ error: "Onboarding must be complete before accepting jobs.", missing: evaluation.missingRequirements }, { status: 403 });
  }

  // Screening payment + admin compliance approval — separate from (and in
  // addition to) the onboarding-completeness gate above. A worker can have
  // a fully complete profile and still not be cleared to accept work if
  // their screening payment hasn't gone through or an admin hasn't
  // approved their compliance record yet.
  const access = await checkOpportunityAccess(worker.id, { assignedWorkerId: null }, "ACCEPT");
  if (!access.allowed) {
    return NextResponse.json({ error: "Complete screening and compliance approval before accepting jobs.", reasonCode: access.reasonCode, missing: access.missingRequirements }, { status: 403 });
  }

  // Geo eligibility is re-checked here even if the feed already filtered —
  // the feed is a convenience, this is the authority. A worker who somehow
  // has a stale/cached view of an out-of-market job must still be blocked.
  const [workerMarkets, workerTerritories] = await Promise.all([
    prisma.workerMarket.findMany({ where: { workerId: worker.id, active: true } }),
    prisma.workerTerritory.findMany({ where: { workerId: worker.id, active: true } }),
  ]);
  const marketMembership = workerMarkets.find((wm) => wm.marketId === job.marketId);
  const eligible = workerCanServeLocation({
    workerMarketIds: workerMarkets.map((wm) => wm.marketId),
    workerTerritoryIds: workerTerritories.map((wt) => wt.territoryId),
    homeLatitude: marketMembership?.homeLatitude ? Number(marketMembership.homeLatitude) : null,
    homeLongitude: marketMembership?.homeLongitude ? Number(marketMembership.homeLongitude) : null,
    serviceRadiusMiles: marketMembership?.serviceRadiusMiles ?? null,
    jobMarketId: job.marketId,
    jobTerritoryId: job.territoryId,
    jobLatitude: job.latitude ? Number(job.latitude) : null,
    jobLongitude: job.longitude ? Number(job.longitude) : null,
  });
  if (!eligible) {
    return NextResponse.json({ error: "This job is outside your active market or service area." }, { status: 403 });
  }

  let assignment: Assignment;
  if (isJunk && junkRole) {
    const detail = await prisma.junkRemovalDetail.findUnique({ where: { jobId } });
    if (!detail) return NextResponse.json({ error: "This junk removal job is missing its details. Contact support." }, { status: 409 });
    const share = junkRole === "HAULER" ? detail.haulerShareCents : detail.helperShareCents;
    let outcome: { assignment: Assignment } | { full: true };
    try {
      outcome = await prisma.$transaction(async (tx) => {
        const existing = await tx.assignment.findUnique({ where: { jobId_workerId: { jobId, workerId: worker.id } } });
        if (existing && (JUNK_SEAT_HOLDING_STATUSES as readonly string[]).includes(existing.status)) return { assignment: existing };
        const held = await tx.assignment.findMany({ where: { jobId, status: { in: [...JUNK_SEAT_HOLDING_STATUSES] } }, select: { junkCrewRole: true } });
        const seats = junkSeats({ helpersRequired: detail.helpersRequired, filledRoles: held.map((h) => h.junkCrewRole) });
        if (junkRole === "HAULER" ? !seats.haulerOpen : seats.helpersOpen === 0) return { full: true as const };
        const seatData = { status: "ACCEPTED" as const, junkCrewRole: junkRole, agreedEarningsCents: share, platformFeeCents: 0, scheduledHours: job.estimatedHours };
        const taken = await tx.assignment.upsert({
          where: { jobId_workerId: { jobId, workerId: worker.id } },
          update: { ...seatData, respondedAt: new Date() },
          create: { jobId, workerId: worker.id, ...seatData },
        });
        const after = junkSeats({ helpersRequired: detail.helpersRequired, filledRoles: [...held.map((h) => h.junkCrewRole), junkRole] });
        await tx.job.update({ where: { id: jobId }, data: { status: after.full ? "CONFIRMED" : "PARTIALLY_FILLED" } });
        return { assignment: taken };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2034") {
        return NextResponse.json({ error: "Someone took a seat on this job at the same moment. Refresh and try again." }, { status: 409 });
      }
      throw e;
    }
    if ("full" in outcome) {
      return NextResponse.json({ error: junkRole === "HAULER" ? "This job already has its hauler." : "This job's helper seats are already filled." }, { status: 409 });
    }
    assignment = outcome.assignment;
  } else {
    assignment = await prisma.assignment.upsert({
      where: { jobId_workerId: { jobId, workerId: worker.id } },
      update: {},
      create: {
        jobId, workerId: worker.id, status: "ACCEPTED",
        agreedEarningsCents: job.customerMoverRateCents,
        scheduledHours: job.estimatedHours,
      },
    });

    const acceptedCount = await prisma.assignment.count({ where: { jobId, status: { in: ["ACCEPTED", "CHECKED_IN", "CHECKED_OUT", "APPROVED"] } } });
    await prisma.job.update({
      where: { id: jobId },
      data: { status: acceptedCount >= job.moversRequired ? "CONFIRMED" : "PARTIALLY_FILLED" },
    });
  }

  const address = await prisma.address.findUnique({ where: { id: job.addressId }, select: { city: true } });
  const notice = assignmentNoticeTemplate({
    workerName: worker.displayName ?? "there", jobTitle: job.title, publicArea: address?.city ?? "the job location", scheduledStart: job.startsAt, jobId: job.id,
  });
  await queueNotification({
    userId: authed.userId, type: "ASSIGNMENT_NOTICE", channels: ["EMAIL", "IN_APP"],
    title: notice.subject, body: notice.text, html: notice.html, idempotencyKey: `assignment-notice:${job.id}:${worker.id}`,
  });

  return NextResponse.json({ assignment }, { status: 201 });
}

