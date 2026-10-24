import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";
import { assertFreightAllowed, FreightGateError } from "@/lib/freight/gate";

/**
 * Accessorials (P0-05, acceptance criterion #8). Structured records, never
 * unexplained adjustments. Request (POST) captures kind + requested amount +
 * supporting document + reason. Approval (PATCH) is a separate admin decision
 * setting the approved amount and customer-billable / carrier-payable flags.
 * Every step is audited.
 */
const ADMIN_ROLES = ["ADMIN", "FINANCE_ADMIN", "SUPER_ADMIN"] as const;
const KINDS = ["DETENTION", "LAYOVER", "LUMPER", "TONU", "DRIVER_ASSIST", "REDELIVERY", "STORAGE", "SCALE", "TOLL", "OTHER"] as const;

const requestSchema = z.object({
  loadId: z.string().min(1),
  kind: z.enum(KINDS),
  requestedAmountCents: z.number().int().nonnegative(),
  supportingDocumentId: z.string().optional(),
  reason: z.string().max(1000).optional(),
});

export async function POST(request: Request) {
  let authed;
  try {
    authed = await requireRole(request, ["CARRIER", "ADMIN", "FINANCE_ADMIN", "SUPER_ADMIN"] as unknown as ("ADMIN")[]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  const parsed = requestSchema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const load = await prisma.freightLoad.findUnique({ where: { id: parsed.data.loadId } });
  if (!load) return NextResponse.json({ error: "Load not found." }, { status: 404 });

  try {
    await assertFreightAllowed({ capability: "carrierLoadAcceptance", userRole: authed.role, marketId: load.marketId });
  } catch (e) {
    if (e instanceof FreightGateError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }

  const acc = await prisma.$transaction(async (tx) => {
    const a = await tx.loadAccessorial.create({
      data: {
        loadId: load.id, kind: parsed.data.kind, requestedAmountCents: parsed.data.requestedAmountCents,
        supportingDocumentId: parsed.data.supportingDocumentId, requestedById: authed.userId, reason: parsed.data.reason,
        approvalStatus: "REQUESTED",
      },
    });
    await tx.freightAuditEvent.create({ data: { loadId: load.id, event: "ACCESSORIAL_REQUESTED", actorId: authed.userId, detail: { accessorialId: a.id, kind: a.kind } } });
    return a;
  });
  return NextResponse.json({ accessorial: acc }, { status: 201 });
}

const approveSchema = z.object({
  accessorialId: z.string().min(1),
  decision: z.enum(["APPROVED", "REJECTED"]),
  approvedAmountCents: z.number().int().nonnegative().optional(),
  customerBillable: z.boolean().optional(),
  carrierPayable: z.boolean().optional(),
  reason: z.string().max(1000).optional(),
});

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

  const acc = await prisma.loadAccessorial.findUnique({ where: { id: parsed.data.accessorialId }, include: { load: true } });
  if (!acc) return NextResponse.json({ error: "Accessorial not found." }, { status: 404 });

  try {
    await assertFreightAllowed({ capability: "carrierLoadAcceptance", userRole: authed.role, marketId: acc.load.marketId, requireAdmin: true });
  } catch (e) {
    if (e instanceof FreightGateError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }

  if (acc.approvalStatus !== "REQUESTED") {
    return NextResponse.json({ error: `Accessorial already ${acc.approvalStatus}.` }, { status: 409 });
  }
  // An approval with a billable amount requires a supporting document.
  if (parsed.data.decision === "APPROVED" && (parsed.data.approvedAmountCents ?? 0) > 0 && !acc.supportingDocumentId) {
    return NextResponse.json({ error: "Approved accessorial requires a supporting document." }, { status: 428 });
  }

  const updated = await prisma.$transaction(async (tx) => {
    const u = await tx.loadAccessorial.update({
      where: { id: acc.id },
      data: {
        approvalStatus: parsed.data.decision, approvedById: authed.userId,
        approvedAmountCents: parsed.data.decision === "APPROVED" ? (parsed.data.approvedAmountCents ?? 0) : null,
        customerBillable: parsed.data.customerBillable ?? false,
        carrierPayable: parsed.data.carrierPayable ?? false,
      },
    });
    await tx.freightAuditEvent.create({ data: { loadId: acc.loadId, event: `ACCESSORIAL_${parsed.data.decision}`, actorId: authed.userId, detail: { accessorialId: acc.id } } });
    return u;
  });
  return NextResponse.json({ accessorial: updated });
}
