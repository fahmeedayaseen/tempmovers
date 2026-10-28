import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";
import { startCheckrScreening } from "@/lib/screening/start-checkr";
import { getScreeningQuote } from "@/lib/screening/packages";
// Junk removal — VASRUE Digital Media, 28 Oct 2026: junk-only worker types screen under the hauler or mover package.
import { screeningRoleFor } from "@/lib/junk/crew";

const schema = z.object({ reason: z.string().min(1, "A sponsorship reason is required.") });

/**
 * Admin sponsorship — changes paymentProvider to PLATFORM_SPONSORED,
 * records the approving admin and reason, and invokes the SAME
 * startCheckrScreening() function a real Stripe payment would, WITHOUT
 * fabricating a paid Stripe event. This can also be used to create a
 * screening charge from scratch for a worker who never went through
 * checkout at all (promotions, hardship cases, strategic recruiting).
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
  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  let charge = await prisma.screeningCharge.findUnique({ where: { id: chargeId }, include: { worker: true } });

  // Allow sponsoring by workerId too, for a worker who has no charge row
  // yet at all (chargeId param doubles as workerId in that case).
  if (!charge) {
    const worker = await prisma.workerProfile.findUnique({ where: { id: chargeId } });
    if (!worker) return NextResponse.json({ error: "Screening charge or worker not found." }, { status: 404 });
    const quote = getScreeningQuote(screeningRoleFor(worker.workerType));
    charge = await prisma.screeningCharge.create({
      data: {
        workerId: worker.id, packageSlug: quote.packageSlug, baseAmountCents: quote.baseAmountCents,
        passThroughAmountCents: quote.estimatedPassThroughCents, totalAmountCents: quote.totalAmountCents,
        status: "QUOTED", feeDisclosureVersion: "screening-fee-v2",
      },
      include: { worker: true },
    });
  }

  if (["PAID", "SCREENING_ORDERED", "SCREENING_PENDING", "APPROVED"].includes(charge.status)) {
    return NextResponse.json({ error: `Charge is already ${charge.status} — nothing to sponsor.` }, { status: 409 });
  }

  const updated = await prisma.screeningCharge.update({
    where: { id: charge.id },
    data: {
      status: "PAID", paidAt: new Date(), paymentProvider: "PLATFORM_SPONSORED",
      sponsoredById: admin.userId, sponsorshipReason: parsed.data.reason,
    },
  });

  await prisma.auditLog.create({
    data: { actorId: admin.userId, action: "SCREENING_SPONSORED", entityType: "ScreeningCharge", entityId: charge.id, details: { reason: parsed.data.reason } },
  });

  await startCheckrScreening(updated.id);

  return NextResponse.json({ screeningCharge: updated });
}
