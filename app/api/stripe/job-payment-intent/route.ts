import { NextResponse } from "next/server";
import { z } from "zod";
import { stripe, mapStripeIntentStatus } from "@/lib/stripe";
import { prisma } from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";
import { claimNextPaymentAttempt, markAttemptCreated, markAttemptFailed } from "@/lib/payment-attempts";
import { ensureStripeCustomer } from "@/lib/ensure-stripe-customer";

/**
 * Server-authoritative: the PaymentIntent amount is built entirely from
 * the job record already resolved and stored at booking time — never
 * recomputed from anything in the request body.
 *
 * Idempotency keys are versioned by attempt number
 * (job-payment-intent:{jobId}:{attemptNumber}) via
 * lib/payment-attempts.ts's atomic claim — hardened after a V25 audit
 * found the original count()+1 approach could let two near-simultaneous
 * requests read the same count and collide. The claim happens (and is
 * durably recorded) BEFORE the Stripe call; the same row is updated
 * with the result afterward, whether that's success or failure.
 */
const schema = z.object({
  jobId: z.string(),
});

export async function POST(request: Request) {
  let authed;
  try {
    authed = await requireRole(request, ["CUSTOMER", "ADMIN"]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }

  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const job = await prisma.job.findUnique({ where: { id: parsed.data.jobId }, include: { customer: true } });
  if (!job) return NextResponse.json({ error: "Job not found." }, { status: 404 });
  if (authed.role === "CUSTOMER" && job.customer.userId !== authed.userId) {
    return NextResponse.json({ error: "Not your job." }, { status: 403 });
  }
  if (job.stripePaymentIntentId && job.paymentStatus !== "FAILED" && job.paymentStatus !== "CANCELED") {
    return NextResponse.json({ error: "Existing authorization must be updated or cancelled first." }, { status: 409 });
  }
  const stripeCustomerId = await ensureStripeCustomer(prisma, job.customerId);

  const attempt = await claimNextPaymentAttempt({ jobId: job.id }, "job-payment-intent");

  let intent;
  try {
    intent = await stripe.paymentIntents.create(
      {
        amount: job.estimatedTotalCents,
        currency: "usd",
        customer: stripeCustomerId,
        capture_method: "manual",
        automatic_payment_methods: { enabled: true },
        metadata: {
          jobId: job.id, attemptNumber: String(attempt.attemptNumber),
          movers: String(job.moversRequired),
          billableHours: String(job.estimatedHours),
          customerMoverRateCents: String(job.customerMoverRateCents),
          platformFeePerManHourCents: String(job.platformFeePerHourCents),
          bookingProtectionFeeCents: String(job.bookingProtectionFeeCents),
        },
      },
      { idempotencyKey: attempt.idempotencyKey },
    );
  } catch (error) {
    await markAttemptFailed(attempt.id, error instanceof Error ? error.message : "Unknown Stripe error");
    return NextResponse.json({ error: "Failed to create PaymentIntent." }, { status: 502 });
  }

  const status = mapStripeIntentStatus(intent.status);

  // Persist the intent ID on the job now — this is what lets the webhook's
  // payment_intent.succeeded/payment_failed handlers find and update this
  // job. Status is derived from the intent's actual state, never asserted.
  await prisma.job.update({
    where: { id: job.id },
    data: { stripePaymentIntentId: intent.id, paymentStatus: status },
  });
  await markAttemptCreated(attempt.id, intent.id, status);

  return NextResponse.json({
    clientSecret: intent.client_secret,
    paymentIntentId: intent.id,
    totalCents: job.estimatedTotalCents,
    attemptNumber: attempt.attemptNumber,
  });
}
