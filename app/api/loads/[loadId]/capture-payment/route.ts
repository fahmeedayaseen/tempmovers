import { NextResponse } from "next/server";
import { stripe } from "@/lib/stripe";
import { prisma } from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";
import { generateDriverReferralBonus } from "@/lib/bonus-generators";
import { captureIntegrationAlert } from "@/lib/monitoring";

/**
 * Captures a freight load's PaymentIntent. Admin-only, gated on POD having
 * been uploaded — this is what the settlement route has been waiting on.
 */
export async function POST(request: Request, context: { params: Promise<{ loadId: string }> }) {
  let authed;
  try {
    authed = await requireRole(request, ["ADMIN"]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  const { loadId } = await context.params;

  const load = await prisma.carrierRoute.findUnique({ where: { id: loadId } });
  if (!load) return NextResponse.json({ error: "Load not found." }, { status: 404 });
  if (load.status !== "POD_UPLOADED") {
    return NextResponse.json({ error: "Proof of delivery must be uploaded before payment capture." }, { status: 409 });
  }
  if (!load.proofOfDeliveryUrl) {
    return NextResponse.json({ error: "Proof-of-delivery file is missing." }, { status: 409 });
  }
  if (!load.stripePaymentIntentId) {
    return NextResponse.json({ error: "This load has no associated PaymentIntent to capture." }, { status: 409 });
  }
  if (load.paymentStatus === "CAPTURED") {
    return NextResponse.json({ error: "Already captured." }, { status: 409 });
  }

  const intent = await stripe.paymentIntents.capture(
    load.stripePaymentIntentId,
    {},
    { idempotencyKey: `load-capture:${load.id}` },
  );

  const updated = await prisma.carrierRoute.update({
    where: { id: load.id },
    data: { paymentStatus: intent.status === "succeeded" ? "CAPTURED" : load.paymentStatus },
  });

  await prisma.auditLog.create({
    data: { actorId: authed.userId, action: "LOAD_PAYMENT_CAPTURED", entityType: "CarrierRoute", entityId: load.id, details: { paymentIntentId: intent.id, status: intent.status } },
  });

  // Driver referral bonus depends on the assigned driver's completedJobs
  // count — see the README note on this route about that count not yet
  // being incremented for freight work specifically, only moving jobs.
  //
  // Wrapped for the same reason as the moving-job capture route: the
  // Stripe capture already succeeded above, and a bonus-generation failure
  // must not turn that success into a 500.
  if (intent.status === "succeeded" && updated.assignedWorkerId) {
    try {
      await generateDriverReferralBonus(prisma, updated.assignedWorkerId);
    } catch (error) {
      captureIntegrationAlert("Payment captured but driver referral bonus accounting failed.", {
        area: "payout", loadId: load.id, error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return NextResponse.json({ load: updated, paymentIntentStatus: intent.status });
}
