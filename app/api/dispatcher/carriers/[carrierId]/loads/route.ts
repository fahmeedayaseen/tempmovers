// ---------------------------------------------------------------------------
// BLOCK-06 — VASRUE Digital Media, 24 October 2026.
// Next.js 15 made dynamic-route `params` a Promise. This file still used the
// Next 14 object form, which no longer satisfies the route-handler constraint
// Next generates into .next/types, so `next build` halted here.
//
// Note for anyone re-running the gate: `tsc --noEmit` does NOT catch this.
// The constraint only exists once Next has generated its route types, so a
// clean typecheck says nothing about it — only a real build does.
//
// The conversion is mechanical: Promise-typed params, await once at the top of
// the handler, then use the destructured value. No auth check, guard, query or
// response shape is altered by this change.
// ---------------------------------------------------------------------------
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
export async function GET(request: Request, { params }: { params: Promise<{ carrierId: string }> }) {
  const { carrierId } = await params;
  let authed;
  try { authed = await requireDispatcher(request); }
  catch (e) { if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status }); throw e; }

  try { await resolveCarrierAccess(authed.userId, carrierId, "VIEW_LOADS"); }
  catch (e) { if (e instanceof DispatcherAccessError) return NextResponse.json({ error: e.message }, { status: e.status }); throw e; }

  const loads = await prisma.freightLoad.findMany({
    where: { assignedCarrierId: carrierId },
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
