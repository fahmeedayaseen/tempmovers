import { NextResponse } from "next/server";
import { z } from "zod";
import { stripe, mapStripeIntentStatus } from "@/lib/stripe";
import { prisma } from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";

/**
 * Same purpose and same V25-audit fix as job-payment-intent/cancel: an
 * existing authorization must be explicitly canceled with Stripe (not
 * just flipped locally), and CANCELED is only ever written locally once
 * Stripe itself confirms canceled — never inferred from an error
 * message, which previously let an actually-succeeded payment be
 * miswritten as CANCELED.
 */
const schema = z.object({ jobId: z.string(), reason: z.string().optional() });

export async function POST(request: Request) {
  let authed;
  try {
    authed = await requireRole(request, ["CUSTOMER", "ADMIN"]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }

  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const load = await prisma.carrierRoute.findUnique({ where: { id: parsed.data.jobId } });
  if (!load) return NextResponse.json({ error: "Load not found." }, { status: 404 });
  if (authed.role !== "ADMIN" && load.postedByUserId !== authed.userId) {
    return NextResponse.json({ error: "You did not post this load." }, { status: 403 });
  }
  if (!load.stripePaymentIntentId) {
    return NextResponse.json({ error: "No PaymentIntent exists for this load." }, { status: 409 });
  }
  if (load.paymentStatus === "CAPTURED") {
    return NextResponse.json({ error: "This load has already been captured — a captured payment cannot be canceled, only refunded." }, { status: 409 });
  }
  if (load.paymentStatus === "CANCELED") {
    return NextResponse.json({ error: "Already canceled." }, { status: 409 });
  }

  const paymentIntentId = load.stripePaymentIntentId;

  try {
    await stripe.paymentIntents.cancel(paymentIntentId, {
      cancellation_reason: "requested_by_customer",
    });
  } catch {
    // Don't infer anything from the error message — retrieve the intent
    // and let Stripe's own reported status decide what happens next.
  }

  const intent = await stripe.paymentIntents.retrieve(paymentIntentId);

  if (intent.status === "succeeded") {
    await prisma.$transaction([
      prisma.carrierRoute.update({ where: { id: load.id }, data: { paymentStatus: "CAPTURED" } }),
      prisma.paymentAttempt.updateMany({
        where: { loadId: load.id, stripePaymentIntentId: paymentIntentId },
        data: { paymentStatus: "CAPTURED" },
      }),
    ]);
    return NextResponse.json({ error: "Payment already succeeded and cannot be canceled. Use the refund flow." }, { status: 409 });
  }

  if (intent.status !== "canceled") {
    const mapped = mapStripeIntentStatus(intent.status);
    await prisma.$transaction([
      prisma.carrierRoute.update({ where: { id: load.id }, data: { paymentStatus: mapped } }),
      prisma.paymentAttempt.updateMany({ where: { loadId: load.id, stripePaymentIntentId: paymentIntentId }, data: { paymentStatus: mapped } }),
    ]);
    return NextResponse.json({ error: `Stripe intent is ${intent.status}; cancellation was not confirmed.` }, { status: 409 });
  }

  const [updated] = await prisma.$transaction([
    prisma.carrierRoute.update({
      where: { id: load.id },
      data: { paymentStatus: "CANCELED" },
    }),
    prisma.paymentAttempt.updateMany({
      where: { loadId: load.id, stripePaymentIntentId: paymentIntentId },
      data: { paymentStatus: "CANCELED", canceledAt: new Date(), cancelReason: parsed.data.reason ?? null },
    }),
  ]);

  await prisma.auditLog.create({
    data: { actorId: authed.userId, action: "LOAD_PAYMENT_INTENT_CANCELED", entityType: "CarrierRoute", entityId: load.id, details: { stripePaymentIntentId: paymentIntentId, reason: parsed.data.reason ?? null } },
  });

  return NextResponse.json({ load: updated });
}
