import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";

/**
 * Admin-only: approves the already-calculated detentionCents amount.
 * Deliberately separate from calculate — a driver-reported wait time
 * shouldn't automatically become a billable charge without a human
 * sign-off, matching how document/compliance decisions elsewhere in this
 * codebase always require an explicit admin action, not an automatic one.
 */
export async function POST(request: Request, context: { params: Promise<{ loadId: string }> }) {
  let admin;
  try {
    admin = await requireRole(request, ["ADMIN"]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  const { loadId } = await context.params;

  const load = await prisma.carrierRoute.findUnique({ where: { id: loadId } });
  if (!load) return NextResponse.json({ error: "Load not found." }, { status: 404 });
  if (load.detentionApprovedAt) return NextResponse.json({ error: "Detention already approved." }, { status: 409 });
  if (!load.actualWaitTimeMinutes || load.detentionCents <= 0) {
    return NextResponse.json({ error: "No detention has been calculated for this load yet." }, { status: 409 });
  }

  const updated = await prisma.carrierRoute.update({
    where: { id: load.id },
    data: { detentionApprovedAt: new Date(), detentionApprovedById: admin.userId },
  });

  await prisma.auditLog.create({
    data: {
      action: "DETENTION_APPROVED", entityType: "CarrierRoute", entityId: load.id,
      details: { detentionCents: load.detentionCents, actualWaitTimeMinutes: load.actualWaitTimeMinutes },
    },
  });

  return NextResponse.json({ load: { id: updated.id, detentionCents: updated.detentionCents, detentionApprovedAt: updated.detentionApprovedAt } });
}
