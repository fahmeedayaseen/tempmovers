import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";
import { assertFreightAllowed, FreightGateError } from "@/lib/freight/gate";
import { canTransitionLoad, type LoadStatus } from "@/lib/freight/load-lifecycle";

/**
 * Proof of Delivery (P0-05). Upload and APPROVAL are deliberately SEPARATE
 * actions (acceptance criterion #7): POST records that a POD document was
 * uploaded (load → POD_PENDING); PATCH is a distinct admin approval that moves
 * the load forward (POD_PENDING → COMPLETED). Uploading never auto-approves.
 */
const ADMIN_ROLES = ["ADMIN", "SUPPORT", "FINANCE_ADMIN", "SUPER_ADMIN"] as const;

// Upload: a carrier (or admin) attaches a POD document reference. Uses the
// private-storage pattern — the storageReference comes from a prior presign.
const uploadSchema = z.object({ loadId: z.string().min(1), storageReference: z.string().min(1) });

export async function POST(request: Request) {
  let authed;
  try {
    authed = await requireRole(request, ["CARRIER", "ADMIN", "SUPPORT", "SUPER_ADMIN"] as unknown as ("ADMIN")[]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  const parsed = uploadSchema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const load = await prisma.freightLoad.findUnique({ where: { id: parsed.data.loadId } });
  if (!load) return NextResponse.json({ error: "Load not found." }, { status: 404 });

  // Ownership: a carrier may only upload POD for its own assigned load.
  if (!["ADMIN", "SUPPORT", "SUPER_ADMIN"].includes(authed.role)) {
    const carrier = load.assignedCarrierId ? await prisma.carrier.findUnique({ where: { id: load.assignedCarrierId }, select: { ownerUserId: true } }) : null;
    if (!carrier || carrier.ownerUserId !== authed.userId) {
      return NextResponse.json({ error: "You are not assigned to this load." }, { status: 403 });
    }
  }

  try {
    await assertFreightAllowed({ capability: "carrierLoadAcceptance", userRole: authed.role, marketId: load.marketId });
  } catch (e) {
    if (e instanceof FreightGateError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }

  const from = load.status as LoadStatus;
  // Record the POD document + move to POD_PENDING if we're at DELIVERED.
  const result = await prisma.$transaction(async (tx) => {
    if (from === "DELIVERED" && canTransitionLoad(from, "POD_PENDING")) {
      await tx.freightLoad.update({ where: { id: load.id }, data: { status: "POD_PENDING" } });
    }
    await tx.freightAuditEvent.create({ data: { loadId: load.id, event: "POD_UPLOADED", actorId: authed.userId, detail: { storageReference: parsed.data.storageReference } } });
    return { ok: true };
  });
  return NextResponse.json({ ...result, note: "POD uploaded. Approval is a separate administrative action." }, { status: 201 });
}

// Approve: a SEPARATE admin action. Only this moves POD_PENDING -> COMPLETED.
const approveSchema = z.object({ loadId: z.string().min(1), approved: z.boolean(), reason: z.string().max(1000).optional() });

export async function PATCH(request: Request) {
  let authed;
  try {
    authed = await requireRole(request, ADMIN_ROLES as unknown as ("ADMIN")[]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  const parsed = approveSchema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const load = await prisma.freightLoad.findUnique({ where: { id: parsed.data.loadId } });
  if (!load) return NextResponse.json({ error: "Load not found." }, { status: 404 });

  try {
    await assertFreightAllowed({ capability: "carrierLoadAcceptance", userRole: authed.role, marketId: load.marketId, requireAdmin: true });
  } catch (e) {
    if (e instanceof FreightGateError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }

  if (load.status !== "POD_PENDING") {
    return NextResponse.json({ error: `POD can only be approved from POD_PENDING; load is ${load.status}.` }, { status: 409 });
  }
  if (!parsed.data.approved) {
    // Rejection stays in POD_PENDING and is audited; no forward transition.
    await prisma.freightAuditEvent.create({ data: { loadId: load.id, event: "POD_REJECTED", actorId: authed.userId, detail: { reason: parsed.data.reason } } });
    return NextResponse.json({ ok: true, approved: false });
  }

  const updated = await prisma.$transaction(async (tx) => {
    const u = await tx.freightLoad.update({ where: { id: load.id }, data: { status: "COMPLETED" } });
    await tx.freightAuditEvent.create({ data: { loadId: load.id, event: "POD_APPROVED", actorId: authed.userId } });
    return u;
  });
  return NextResponse.json({ load: updated, approved: true });
}
