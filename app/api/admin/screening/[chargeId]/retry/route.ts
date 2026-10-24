import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";
import { startCheckrScreening } from "@/lib/screening/start-checkr";

/**
 * Retries Checkr invitation creation for a charge that's PAID but never
 * got a BackgroundCheck (the "payment succeeded, invitation creation
 * failed" case from section 12 of the handoff — flagged via
 * captureIntegrationAlert in lib/screening/start-checkr.ts when it first
 * happens). Does NOT charge again — startCheckrScreening only acts on
 * charges already PAID, and is a no-op if a BackgroundCheck already exists.
 */
export async function POST(request: Request, context: { params: Promise<{ chargeId: string }> }) {
  let admin;
  try {
    admin = await requireRole(request, ["ADMIN"]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  const { chargeId } = await context.params;

  const charge = await prisma.screeningCharge.findUnique({ where: { id: chargeId } });
  if (!charge) return NextResponse.json({ error: "Screening charge not found." }, { status: 404 });
  if (charge.status !== "PAID") {
    return NextResponse.json({ error: `Charge is ${charge.status}, not PAID — nothing to retry.` }, { status: 409 });
  }

  await startCheckrScreening(chargeId);

  const updated = await prisma.screeningCharge.findUnique({ where: { id: chargeId } });
  await prisma.auditLog.create({
    data: { actorId: admin.userId, action: "SCREENING_RETRY", entityType: "ScreeningCharge", entityId: chargeId },
  });

  return NextResponse.json({ screeningCharge: updated });
}
