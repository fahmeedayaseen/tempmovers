import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireDispatcher, resolveCarrierAccess, DispatcherAccessError, AuthError } from "@/lib/dispatcher/access";
import { isBrokerageCapabilityEnabled } from "@/lib/compliance/service-separation";

/**
 * Dispatcher load detail — for the load workspace. Requires VIEW_LOADS on the
 * load's carrier. Returns operational data (stops, offers, rate cons, documents,
 * settlement STATUS only). Deliberately omits financial margin internals,
 * factoring documents, and compliance/audit-admin data. Settlement is exposed
 * as read-only status, never a payment action.
 */
export async function GET(request: Request, { params }: { params: { loadId: string } }) {
  let authed;
  try { authed = await requireDispatcher(request); }
  catch (e) { if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status }); throw e; }

  const load = await prisma.freightLoad.findUnique({
    where: { id: params.loadId },
    select: {
      id: true, status: true, commodity: true, equipmentType: true, weightLbs: true, palletCount: true,
      carrierTotalCents: true, assignedCarrierId: true, marketId: true,
      stops: { orderBy: { sequence: "asc" } },
      offers: { orderBy: { createdAt: "desc" }, select: { id: true, carrierId: true, offeredRateCents: true, status: true, expiresAt: true, declineReason: true } },
      rateConfirmations: { orderBy: { version: "desc" }, select: { id: true, version: true, agreedCarrierRateCents: true, acceptedAt: true } },
      settlements: { select: { id: true, status: true } },
    },
  });
  if (!load) return NextResponse.json({ error: "Load not found." }, { status: 404 });
  if (!load.assignedCarrierId) return NextResponse.json({ error: "Load not assigned." }, { status: 404 });

  try { await resolveCarrierAccess(authed.userId, load.assignedCarrierId, "VIEW_LOADS"); }
  catch (e) { if (e instanceof DispatcherAccessError) return NextResponse.json({ error: e.message }, { status: e.status }); throw e; }

  const brokerageActive = await isBrokerageCapabilityEnabled("loadPosting");
  return NextResponse.json({ load, brokerageActive });
}
