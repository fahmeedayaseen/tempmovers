import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";
import { blockUnlessFunded } from "@/lib/payments/funding";
import { evaluateWorkerEligibility } from "@/lib/worker-eligibility";
import { checkOpportunityAccess } from "@/lib/access/opportunity-access";
import { claimFreightLoad } from "@/lib/freight-claim";

export async function POST(request: Request, context: { params: Promise<{ loadId: string }> }) {
  let authed;
  try {
    authed = await requireRole(request, ["DRIVER"]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  const { loadId } = await context.params;

  const load = await prisma.carrierRoute.findUnique({ where: { id: loadId } });
  if (!load) return NextResponse.json({ error: "Load not found." }, { status: 404 });
  if (load.status !== "OPEN" && load.status !== "OFFER_RECEIVED") {
    return NextResponse.json({ error: "Load is no longer open." }, { status: 409 });
  }
  // Pay before dispatch — VASRUE Digital Media, 29 Oct 2026: an unpaid load cannot be claimed.
  const unfunded = await blockUnlessFunded({ type: "LOAD", id: loadId }, { action: "claimed", actorUserId: authed.userId });
  if (unfunded) return unfunded;

  const worker = await prisma.workerProfile.findUnique({ where: { userId: authed.userId } });
  if (!worker) return NextResponse.json({ error: "Driver profile not found." }, { status: 404 });

  if (!["BOX_TRUCK_DRIVER", "SEMI_DRIVER"].includes(worker.workerType)) {
    return NextResponse.json({ allowed: false, reason: "DRIVER_PROFILE_REQUIRED" }, { status: 403 });
  }

  const evaluation = await evaluateWorkerEligibility({ workerId: worker.id, context: "FREIGHT_LOAD_REQUEST", equipmentType: load.equipmentType });
  if (!evaluation.allowed) {
    const reason = evaluation.missingRequirements.includes("PLAN_OR_EQUIPMENT_NOT_ELIGIBLE") ? "PLAN_OR_EQUIPMENT_NOT_ELIGIBLE" : "ONBOARDING_INCOMPLETE";
    return NextResponse.json({ allowed: false, reason, missing: evaluation.missingRequirements }, { status: 403 });
  }

  const access = await checkOpportunityAccess(worker.id, { assignedWorkerId: load.assignedWorkerId ?? null }, "REQUEST");
  if (!access.allowed) {
    return NextResponse.json({ allowed: false, reason: access.reasonCode ?? "COMPLIANCE_INCOMPLETE", missing: access.missingRequirements }, { status: 403 });
  }

  // Market eligibility re-check — the board (GET /api/driver/loads) already
  // filters to the driver's markets, but this is the actual enforcement point.
  const workerMarket = await prisma.workerMarket.findFirst({
    where: { workerId: worker.id, active: true, marketId: load.originMarketId ?? undefined },
  });
  if (!load.originMarketId || !workerMarket) {
    return NextResponse.json({ allowed: false, reason: "OUTSIDE_ACTIVE_MARKET" }, { status: 403 });
  }

  if (load.visibility === "VERIFIED_CARRIERS_ONLY" && worker.identityVerification !== "APPROVED") {
    return NextResponse.json({ allowed: false, reason: "NOT_A_VERIFIED_CARRIER" }, { status: 403 });
  }
  if (load.visibility === "PREFERRED_NETWORK") {
    const invited = await prisma.preferredWorker.findFirst({
      where: { workerId: worker.id, partnerId: load.partnerOrganizationId ?? undefined },
    });
    if (!invited) return NextResponse.json({ allowed: false, reason: "NOT_IN_PREFERRED_NETWORK" }, { status: 403 });
  }
  if (load.visibility === "PRIVATE_CONFIDENTIAL") {
    const invitation = await prisma.carrierRouteInvitation.findFirst({
      where: { carrierRouteId: load.id, workerId: worker.id, status: "ACCEPTED" },
    });
    if (!invitation) return NextResponse.json({ allowed: false, reason: "PRIVATE_LOAD_REQUIRES_INVITE" }, { status: 403 });
  }

  const result = await claimFreightLoad(loadId, worker.id, authed.userId, "LOAD_ASSIGNED");
  if (!result.ok) {
    return NextResponse.json({ allowed: false, reason: result.reason }, { status: 409 });
  }

  // Full details are only ever returned here — after assignment to a verified, gated worker.
  return NextResponse.json({ allowed: true, load: result.load });
}
