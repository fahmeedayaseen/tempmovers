import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireDispatcher, resolveCarrierAccess, DispatcherAccessError, AuthError } from "@/lib/dispatcher/access";
import { assertFreightAllowed, FreightGateError } from "@/lib/freight/gate";
import { canTransitionLoad } from "@/lib/freight/load-lifecycle";

/**
 * Dispatcher load status update — a BROKERED action, so it passes through BOTH
 * gates:
 *   1. Dispatcher authorization: UPDATE_LOAD_STATUS permission on the load's
 *      carrier (resolved server-side).
 *   2. Brokerage capability: assertFreightAllowed(loadPosting) — stays blocked
 *      while brokerage is dormant.
 * Plus the backend status machine (canTransitionLoad). A dispatcher can only
 * advance operational milestones for a carrier that authorized them.
 */
const schema = z.object({ toStatus: z.string().min(1), reason: z.string().max(1000).optional() });

// Milestones a dispatcher may drive (operational chain only — never financial
// states like INVOICED/PAID, which are not dispatcher concerns).
const DISPATCHER_ALLOWED_TARGETS = new Set(["AT_PICKUP", "LOADED", "IN_TRANSIT", "AT_DELIVERY", "DELIVERED", "POD_PENDING", "EXCEPTION"]);

export async function PATCH(request: Request, { params }: { params: { loadId: string } }) {
  let authed;
  try { authed = await requireDispatcher(request); }
  catch (e) { if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status }); throw e; }

  const load = await prisma.freightLoad.findUnique({ where: { id: params.loadId }, select: { id: true, status: true, marketId: true, assignedCarrierId: true } });
  if (!load) return NextResponse.json({ error: "Load not found." }, { status: 404 });
  if (!load.assignedCarrierId) return NextResponse.json({ error: "Load has no assigned carrier." }, { status: 409 });

  // Gate 1: dispatcher must have UPDATE_LOAD_STATUS on this carrier.
  try { await resolveCarrierAccess(authed.userId, load.assignedCarrierId, "UPDATE_LOAD_STATUS"); }
  catch (e) { if (e instanceof DispatcherAccessError) return NextResponse.json({ error: e.message }, { status: e.status }); throw e; }

  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  const toStatus = parsed.data.toStatus;

  if (!DISPATCHER_ALLOWED_TARGETS.has(toStatus)) {
    return NextResponse.json({ error: "Dispatchers can only update operational milestones for this load." }, { status: 403 });
  }

  // Gate 2: brokerage capability. requireAdmin:false — a dispatcher's authority
  // comes from the carrier grant, not an admin role.
  try { await assertFreightAllowed({ capability: "loadPosting", userRole: authed.role, marketId: load.marketId, requireAdmin: false }); }
  catch (e) { if (e instanceof FreightGateError) return NextResponse.json({ error: e.message, capability: "loadPosting" }, { status: 403 }); throw e; }

  if (!canTransitionLoad(load.status as never, toStatus as never)) {
    return NextResponse.json({ error: `Cannot move from ${load.status} to ${toStatus}.`, currentStatus: load.status }, { status: 409 });
  }

  const updated = await prisma.$transaction(async (tx) => {
    const u = await tx.freightLoad.update({ where: { id: load.id }, data: { status: toStatus as never } });
    await tx.freightAuditEvent.create({ data: { loadId: load.id, event: "STATUS_CHANGED", detail: { from: load.status, to: toStatus, by: "dispatcher", reason: parsed.data.reason ?? null }, actorId: authed.userId } });
    return u;
  });
  return NextResponse.json({ status: updated.status });
}
