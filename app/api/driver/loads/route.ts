import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";
import { evaluateWorkerEligibility } from "@/lib/worker-eligibility";
import { SANITIZED_LOAD_SELECT } from "@/lib/access/sanitize-load";
import type { Prisma } from "@prisma/client";

// Fields safe to return once a caller is an authenticated worker — still excludes
// exact addresses, shipper contact, commodity detail, access codes, and private
// documents, which stay gated behind /api/loads/[id]/request until assignment.
const AUTHED_LOAD_SELECT = SANITIZED_LOAD_SELECT;

const querySchema = z.object({
  equipment: z.enum(["BOX_TRUCK", "SEMI_TRACTOR", "SEMI_TRACTOR_TRAILER", "all"]).optional(),
  routeType: z.enum(["local", "regional", "all"]).optional(),
});

/**
 * Authenticated board: adds VERIFIED_CARRIERS_ONLY (for identity-verified workers)
 * and PREFERRED_NETWORK (only loads tied to a partner org this worker is actually
 * on the preferred-worker roster for) on top of the public PUBLIC_PREVIEW set.
 * PRIVATE_CONFIDENTIAL and INTERNAL_DRAFT never appear here — those require a
 * direct invite record, never a board listing.
 */
export async function GET(request: Request) {
  let authed;
  try {
    authed = await requireRole(request, ["DRIVER"]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }

  const { searchParams } = new URL(request.url);
  const parsed = querySchema.safeParse(Object.fromEntries(searchParams));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  const q = parsed.data;

  const worker = await prisma.workerProfile.findUnique({ where: { userId: authed.userId } });
  if (!worker) return NextResponse.json({ error: "Worker profile not found." }, { status: 404 });

  // Market membership gates the board the same way it gates acceptance —
  // see lib/geo.ts. A worker with no active WorkerMarket rows sees nothing,
  // rather than defaulting open; that's the same fail-closed posture as
  // workerCanServeLocation.
  const workerMarkets = await prisma.workerMarket.findMany({ where: { workerId: worker.id, active: true } });
  const marketIds = workerMarkets.map((wm) => wm.marketId);

  const allowedVisibility: Prisma.CarrierRouteWhereInput[] = [{ visibility: "PUBLIC_PREVIEW" }];
  if (worker.identityVerification === "APPROVED") {
    allowedVisibility.push({ visibility: "VERIFIED_CARRIERS_ONLY" });
  }
  allowedVisibility.push({
    visibility: "PREFERRED_NETWORK",
    partnerOrganization: { preferredWorkers: { some: { workerId: worker.id } } },
  });

  const where: Prisma.CarrierRouteWhereInput = {
    status: { in: ["OPEN", "OFFER_RECEIVED"] },
    OR: allowedVisibility,
    originMarketId: { in: marketIds },
  };
  if (q.equipment && q.equipment !== "all") where.equipmentType = q.equipment;
  if (q.routeType === "local") where.isLocalRoute = true;
  if (q.routeType === "regional") where.isLocalRoute = false;

  const loads = await prisma.carrierRoute.findMany({
    where,
    select: AUTHED_LOAD_SELECT,
    orderBy: { pickupDate: "asc" },
    take: 50,
  });

  // Browsing stays allowed during onboarding/review — only actually
  // requesting a load is gated (enforced again, authoritatively, in
  // POST /api/loads/[loadId]/request). This lets the frontend show a
  // "complete onboarding to request loads" state instead of a dead end.
  const evaluation = await evaluateWorkerEligibility({ workerId: worker.id, context: "FREIGHT_LOAD_REQUEST" });

  return NextResponse.json({
    loads: loads.map((l) => ({ ...l, locked: l.visibility !== "PUBLIC_PREVIEW" })),
    canRequestLoads: evaluation.allowed,
  });
}
