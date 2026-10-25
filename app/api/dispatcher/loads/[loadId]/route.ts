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
 * Dispatcher load detail — for the load workspace. Requires VIEW_LOADS on the
 * load's carrier. Returns operational data (stops, offers, rate cons, documents,
 * settlement STATUS only). Deliberately omits financial margin internals,
 * factoring documents, and compliance/audit-admin data. Settlement is exposed
 * as read-only status, never a payment action.
 */
export async function GET(request: Request, { params }: { params: Promise<{ loadId: string }> }) {
  const { loadId } = await params;
  let authed;
  try { authed = await requireDispatcher(request); }
  catch (e) { if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status }); throw e; }

  const load = await prisma.freightLoad.findUnique({
    where: { id: loadId },
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
