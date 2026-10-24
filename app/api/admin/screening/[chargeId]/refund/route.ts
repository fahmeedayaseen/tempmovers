import { NextResponse } from "next/server";
import { z } from "zod";
import { stripe } from "@/lib/stripe";
import { prisma } from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";

const schema = z.object({ reason: z.string().min(1, "A refund reason is required.") });

/**
 * Full refund is only permitted before screening has been ordered with
 * Checkr — per the handoff: after a third-party screening is ordered,
 * refunding already-incurred third-party fees needs the published refund
 * policy and explicit approval, not a blanket automatic refund. This route
 * enforces that distinction rather than leaving it as a documentation-only
 * rule an admin could accidentally violate.
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

  const charge = await prisma.screeningCharge.findUnique({ where: { id: chargeId } });
  if (!charge) return NextResponse.json({ error: "Screening charge not found." }, { status: 404 });
  if (charge.status !== "PAID") {
    return NextResponse.json({
      error: charge.status === "SCREENING_ORDERED" || charge.status === "SCREENING_PENDING"
        ? "Screening has already been ordered with the provider — this needs a manual refund-policy review, not an automatic refund."
        : `Charge is ${charge.status}, not eligible for this refund path.`,
    }, { status: 409 });
  }
  if (!charge.stripePaymentIntentId) return NextResponse.json({ error: "No payment intent on this charge." }, { status: 409 });

  const refund = await stripe.refunds.create(
    { payment_intent: charge.stripePaymentIntentId, reason: "requested_by_customer" },
    { idempotencyKey: `screening-refund:${charge.id}` },
  );

  const updated = await prisma.screeningCharge.update({
    where: { id: charge.id },
    data: { status: "REFUNDED", refundedAt: new Date(), stripeRefundId: refund.id },
  });

  await prisma.auditLog.create({
    data: { actorId: admin.userId, action: "SCREENING_REFUNDED", entityType: "ScreeningCharge", entityId: charge.id, details: { reason: parsed.data.reason, stripeRefundId: refund.id } },
  });

  return NextResponse.json({ screeningCharge: updated });
}
