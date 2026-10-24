import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";
import { assertFreightAllowed, FreightGateError } from "@/lib/freight/gate";
import { getCarrierEligibility } from "@/lib/carriers/eligibility-service";

/**
 * Rate confirmation generation + acknowledgment (P0-05). Generated ONLY after
 * offer acceptance + eligibility recheck + compliance gates. A material-term
 * change creates a NEW version requiring acknowledgment (@@unique[loadId,version]).
 */
const ADMIN_ROLES = ["ADMIN", "FINANCE_ADMIN", "SUPER_ADMIN"] as const;

const genSchema = z.object({
  loadId: z.string().min(1),
  agreedCarrierRateCents: z.number().int().nonnegative(),
  equipment: z.string().max(60).optional(),
  commodity: z.string().max(200).optional(),
  paymentTerms: z.string().max(500).optional(),
});

export async function POST(request: Request) {
  let authed;
  try {
    authed = await requireRole(request, ADMIN_ROLES as unknown as ("ADMIN")[]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  const parsed = genSchema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const load = await prisma.freightLoad.findUnique({ where: { id: parsed.data.loadId } });
  if (!load) return NextResponse.json({ error: "Load not found." }, { status: 404 });
  if (!load.assignedCarrierId) return NextResponse.json({ error: "Load has no assigned carrier." }, { status: 409 });

  try {
    await assertFreightAllowed({ capability: "rateConfirmationGeneration", userRole: authed.role, marketId: load.marketId, requireAdmin: true });
  } catch (e) {
    if (e instanceof FreightGateError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }

  const eligibility = await getCarrierEligibility(load.assignedCarrierId, "BROKER_LOAD_ASSIGNMENT", load.marketId);
  if (!eligibility.eligible) return NextResponse.json({ error: "Carrier is not eligible.", blockers: eligibility.blockers }, { status: 428 });

  const last = await prisma.rateConfirmation.findFirst({ where: { loadId: load.id }, orderBy: { version: "desc" }, select: { version: true } });
  const version = (last?.version ?? 0) + 1;

  const rc = await prisma.$transaction(async (tx) => {
    const created = await tx.rateConfirmation.create({
      data: {
        loadId: load.id, loadVersion: load.version, carrierId: load.assignedCarrierId!, version,
        agreedCarrierRateCents: parsed.data.agreedCarrierRateCents, equipment: parsed.data.equipment, commodity: parsed.data.commodity, paymentTerms: parsed.data.paymentTerms,
      },
    });
    await tx.freightAuditEvent.create({ data: { loadId: load.id, event: "RATE_CONFIRMATION_GENERATED", actorId: authed.userId, detail: { version } } });
    return created;
  });
  return NextResponse.json({ rateConfirmation: rc }, { status: 201 });
}

const ackSchema = z.object({ rateConfirmationId: z.string().min(1) });

export async function PATCH(request: Request) {
  let authed;
  try {
    authed = await requireRole(request, ["CARRIER", "ADMIN", "SUPER_ADMIN"] as unknown as ("ADMIN")[]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  const parsed = ackSchema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const rc = await prisma.rateConfirmation.findUnique({ where: { id: parsed.data.rateConfirmationId } });
  if (!rc) return NextResponse.json({ error: "Rate confirmation not found." }, { status: 404 });

  if (!["ADMIN", "SUPER_ADMIN"].includes(authed.role)) {
    const carrier = await prisma.carrier.findUnique({ where: { id: rc.carrierId }, select: { ownerUserId: true } });
    if (!carrier || carrier.ownerUserId !== authed.userId) return NextResponse.json({ error: "Not authorized." }, { status: 403 });
  }

  const updated = await prisma.$transaction(async (tx) => {
    const u = await tx.rateConfirmation.update({ where: { id: rc.id }, data: { acceptedAt: new Date() } });
    await tx.freightAuditEvent.create({ data: { loadId: rc.loadId, event: "RATE_CONFIRMATION_ACKNOWLEDGED", actorId: authed.userId, detail: { version: rc.version } } });
    return u;
  });
  return NextResponse.json({ rateConfirmation: updated });
}
