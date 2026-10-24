import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";
import { assertFreightAllowed, FreightGateError } from "@/lib/freight/gate";
import { canTransitionLoad, computeLoadFinancials, type LoadStatus } from "@/lib/freight/load-lifecycle";

/**
 * Freight load creation + status transitions (P0-05). DORMANT behind the
 * brokerage gate. Creation is idempotent via creationKey; transitions go
 * through the validated status machine; every mutation writes an append-only
 * FreightAuditEvent.
 */
const ADMIN_ROLES = ["ADMIN", "FINANCE_ADMIN", "SUPER_ADMIN"] as const;

const createSchema = z.object({
  marketId: z.string().min(1),
  creationKey: z.string().min(8).max(200),
  commodity: z.string().max(200).optional(),
  weightLbs: z.number().int().positive().optional(),
  palletCount: z.number().int().positive().optional(),
  equipmentType: z.string().max(60).optional(),
  customerLinehaulCents: z.number().int().nonnegative().default(0),
  customerFuelSurchargeCents: z.number().int().nonnegative().default(0),
  customerAccessorialsCents: z.number().int().nonnegative().default(0),
  carrierLinehaulCents: z.number().int().nonnegative().default(0),
  carrierFuelSurchargeCents: z.number().int().nonnegative().default(0),
  carrierAccessorialsCents: z.number().int().nonnegative().default(0),
  processingFeesCents: z.number().int().nonnegative().default(0),
});

export async function POST(request: Request) {
  let authed;
  try {
    authed = await requireRole(request, ADMIN_ROLES as unknown as ("ADMIN")[]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  const parsed = createSchema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  const data = parsed.data;

  try {
    await assertFreightAllowed({ capability: "loadPosting", userRole: authed.role, marketId: data.marketId, requireAdmin: true });
  } catch (e) {
    if (e instanceof FreightGateError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }

  // Idempotency: a repeated creationKey returns the existing load.
  const existing = await prisma.freightLoad.findUnique({ where: { creationKey: data.creationKey } });
  if (existing) return NextResponse.json({ load: existing, idempotent: true });

  const fin = computeLoadFinancials(data); // throws on non-integer cents

  const load = await prisma.$transaction(async (tx) => {
    const l = await tx.freightLoad.create({
      data: {
        status: "DRAFT", marketId: data.marketId, createdById: authed.userId, creationKey: data.creationKey,
        commodity: data.commodity, weightLbs: data.weightLbs, palletCount: data.palletCount, equipmentType: data.equipmentType,
        customerLinehaulCents: fin.customerLinehaulCents, customerFuelSurchargeCents: fin.customerFuelSurchargeCents, customerAccessorialsCents: fin.customerAccessorialsCents, customerTotalCents: fin.customerTotalCents,
        carrierLinehaulCents: fin.carrierLinehaulCents, carrierFuelSurchargeCents: fin.carrierFuelSurchargeCents, carrierAccessorialsCents: fin.carrierAccessorialsCents, carrierTotalCents: fin.carrierTotalCents,
        grossMarginCents: fin.grossMarginCents, processingFeesCents: fin.processingFeesCents, platformRevenueCents: fin.platformRevenueCents,
      },
    });
    await tx.freightAuditEvent.create({ data: { loadId: l.id, event: "LOAD_CREATED", actorId: authed.userId, detail: { marketId: data.marketId } } });
    return l;
  });

  return NextResponse.json({ load }, { status: 201 });
}

const transitionSchema = z.object({ loadId: z.string().min(1), toStatus: z.string().min(1), reason: z.string().max(1000).optional() });

export async function PATCH(request: Request) {
  let authed;
  try {
    authed = await requireRole(request, ADMIN_ROLES as unknown as ("ADMIN")[]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  const parsed = transitionSchema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const load = await prisma.freightLoad.findUnique({ where: { id: parsed.data.loadId } });
  if (!load) return NextResponse.json({ error: "Load not found." }, { status: 404 });

  try {
    await assertFreightAllowed({ capability: "loadPosting", userRole: authed.role, marketId: load.marketId, requireAdmin: true });
  } catch (e) {
    if (e instanceof FreightGateError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }

  const from = load.status as LoadStatus;
  const to = parsed.data.toStatus as LoadStatus;
  if (!canTransitionLoad(from, to)) {
    return NextResponse.json({ error: `Illegal load status transition: ${from} -> ${to}.` }, { status: 409 });
  }

  const updated = await prisma.$transaction(async (tx) => {
    const u = await tx.freightLoad.update({ where: { id: load.id }, data: { status: to } });
    await tx.freightAuditEvent.create({ data: { loadId: load.id, event: "STATUS_CHANGED", actorId: authed.userId, detail: { from, to, reason: parsed.data.reason } } });
    return u;
  });
  return NextResponse.json({ load: updated });
}
