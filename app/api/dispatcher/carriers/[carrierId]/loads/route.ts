import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireDispatcher, resolveCarrierAccess, DispatcherAccessError, AuthError } from "@/lib/dispatcher/access";
import { isBrokerageCapabilityEnabled } from "@/lib/compliance/service-separation";

/**
 * Loads for one authorized carrier. Requires VIEW_LOADS on that carrier,
 * resolved server-side. Returns loads assigned to the carrier; money is integer
 * cents (UI formats). Includes brokerageActive so the UI can disable brokered
 * actions while dormant.
 */
export async function GET(request: Request, { params }: { params: { carrierId: string } }) {
  let authed;
  try { authed = await requireDispatcher(request); }
  catch (e) { if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status }); throw e; }

  try { await resolveCarrierAccess(authed.userId, params.carrierId, "VIEW_LOADS"); }
  catch (e) { if (e instanceof DispatcherAccessError) return NextResponse.json({ error: e.message }, { status: e.status }); throw e; }

  const loads = await prisma.freightLoad.findMany({
    where: { assignedCarrierId: params.carrierId },
    select: {
      id: true, status: true, commodity: true, equipmentType: true, weightLbs: true,
      carrierTotalCents: true, createdAt: true, updatedAt: true,
      stops: { orderBy: { sequence: "asc" }, select: { sequence: true, stopType: true, city: true, state: true, appointmentAt: true } },
    },
    orderBy: { updatedAt: "desc" }, take: 300,
  });

  const brokerageActive = await isBrokerageCapabilityEnabled("loadPosting");
  return NextResponse.json({ loads, brokerageActive });
}
