import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";
import { calculateDetention } from "@/lib/pricing";

/**
 * The assigned driver records arrival/departure at the pickup, the server
 * derives actualWaitTimeMinutes from those timestamps and computes
 * detentionCents via calculateDetention() — the driver never submits the
 * dollar amount directly, only what they observed happening.
 */
const schema = z.object({
  arrivedAt: z.string().datetime(),
  departedPickupAt: z.string().datetime(),
});

export async function POST(request: Request, context: { params: Promise<{ loadId: string }> }) {
  let authed;
  try {
    authed = await requireRole(request, ["DRIVER", "ADMIN"]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  const { loadId } = await context.params;
  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const load = await prisma.carrierRoute.findUnique({ where: { id: loadId }, include: { assignedWorker: true } });
  if (!load) return NextResponse.json({ error: "Load not found." }, { status: 404 });

  if (authed.role === "DRIVER") {
    if (!load.assignedWorker || load.assignedWorker.userId !== authed.userId) {
      return NextResponse.json({ error: "You are not the assigned driver for this load." }, { status: 403 });
    }
  }
  if (load.detentionApprovedAt) {
    return NextResponse.json({ error: "Detention for this load has already been approved and cannot be recalculated." }, { status: 409 });
  }

  const arrivedAt = new Date(parsed.data.arrivedAt);
  const departedPickupAt = new Date(parsed.data.departedPickupAt);
  const actualWaitTimeMinutes = Math.max(0, Math.round((departedPickupAt.getTime() - arrivedAt.getTime()) / 60000));

  const { detentionCents, excessMinutes, billableQuarterHours } = calculateDetention({
    actualWaitTimeMinutes,
    includedMinutes: load.waitTimeIncludedMinutes,
    hourlyRateCents: load.waitTimeRateCents,
  });

  const updated = await prisma.carrierRoute.update({
    where: { id: load.id },
    data: { arrivedAt, departedPickupAt, actualWaitTimeMinutes, detentionCents },
  });

  await prisma.auditLog.create({
    data: {
      action: "DETENTION_CALCULATED", entityType: "CarrierRoute", entityId: load.id,
      details: { actualWaitTimeMinutes, excessMinutes, billableQuarterHours, detentionCents },
    },
  });

  return NextResponse.json({
    load: { id: updated.id, actualWaitTimeMinutes: updated.actualWaitTimeMinutes, detentionCents: updated.detentionCents },
    excessMinutes, billableQuarterHours,
  });
}
