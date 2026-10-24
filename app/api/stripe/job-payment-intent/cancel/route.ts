import { NextResponse } from "next/server";
import { z } from "zod";
import { stripe, mapStripeIntentStatus } from "@/lib/stripe";
import { prisma } from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";

/**
 * Explicitly cancels the current PaymentIntent via Stripe (not just a
 * local status flip — an uncanceled Stripe-side authorization would
 * still be sitting on the customer's card), then clears the way for a
 * genuinely new authorization attempt on the next create-intent call.
 *
 * Hardened after a V25 audit found a real financial-state-corruption
 * bug: the previous version treated a Stripe "already succeeded" error
 * the same as "already canceled" and unconditionally wrote CANCELED
 * locally either way — meaning an actually-captured, successfully-paid
 * job could get marked CANCELED in our own database while Stripe
 * correctly still shows it as succeeded. Fixed: after any cancellation
 * error, the intent is RETRIEVED from Stripe and its real status is
 * what gets written locally — CANCELED is only ever written when
 * Stripe itself reports canceled. A succeeded intent is recorded as
 * CAPTURED and returns an error pointing at the refund flow instead.
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

  const job = await prisma.job.findUnique({ where: { id: parsed.data.jobId }, include: { customer: true } });
  if (!job) return NextResponse.json({ error: "Job not found." }, { status: 404 });
  if (authed.role === "CUSTOMER" && job.customer.userId !== authed.userId) {
    return NextResponse.json({ error: "Not your job." }, { status: 403 });
  }
  if (!job.stripePaymentIntentId) {
    return NextResponse.json({ error: "No PaymentIntent exists for this job." }, { status: 409 });
  }
  if (job.paymentStatus === "CAPTURED") {
    return NextResponse.json({ error: "This job has already been captured — a captured payment cannot be canceled, only refunded." }, { status: 409 });
  }
  if (job.paymentStatus === "CANCELED") {
    return NextResponse.json({ error: "Already canceled." }, { status: 409 });
  }

  const paymentIntentId = job.stripePaymentIntentId;

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
      prisma.job.update({ where: { id: job.id }, data: { paymentStatus: "CAPTURED" } }),
      prisma.paymentAttempt.updateMany({
        where: { jobId: job.id, stripePaymentIntentId: paymentIntentId },
        data: { paymentStatus: "CAPTURED" },
      }),
    ]);
    return NextResponse.json({ error: "Payment already succeeded and cannot be canceled. Use the refund flow." }, { status: 409 });
  }

  if (intent.status !== "canceled") {
    // Reflect whatever Stripe actually reports rather than assuming —
    // e.g. requires_action, processing. Cancellation was not confirmed;
    // do not write CANCELED.
    const mapped = mapStripeIntentStatus(intent.status);
    await prisma.$transaction([
      prisma.job.update({ where: { id: job.id }, data: { paymentStatus: mapped } }),
      prisma.paymentAttempt.updateMany({ where: { jobId: job.id, stripePaymentIntentId: paymentIntentId }, data: { paymentStatus: mapped } }),
    ]);
    return NextResponse.json({ error: `Stripe intent is ${intent.status}; cancellation was not confirmed.` }, { status: 409 });
  }

  // Only here — Stripe has confirmed canceled — may local state be
  // written as CANCELED.
  const [updated] = await prisma.$transaction([
    prisma.job.update({
      where: { id: job.id },
      data: { paymentStatus: "CANCELED" },
    }),
    prisma.paymentAttempt.updateMany({
      where: { jobId: job.id, stripePaymentIntentId: paymentIntentId },
      data: { paymentStatus: "CANCELED", canceledAt: new Date(), cancelReason: parsed.data.reason ?? null },
    }),
  ]);

  await prisma.auditLog.create({
    data: { actorId: authed.userId, action: "JOB_PAYMENT_INTENT_CANCELED", entityType: "Job", entityId: job.id, details: { stripePaymentIntentId: paymentIntentId, reason: parsed.data.reason ?? null } },
  });

  return NextResponse.json({ job: updated });
}
