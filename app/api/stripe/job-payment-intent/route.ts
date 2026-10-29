import { NextResponse } from "next/server";
import { z } from "zod";
import { stripe, mapStripeIntentStatus } from "@/lib/stripe";
import { prisma } from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";
import { claimNextPaymentAttempt, markAttemptCreated, markAttemptFailed } from "@/lib/payment-attempts";
import { ensureStripeCustomer } from "@/lib/ensure-stripe-customer";
import { findReusableIntent } from "@/lib/stripe-intent-reuse";
import { ensureQuoteVersion, fundingPaymentMethodTypes } from "@/lib/payments/funding";
import { marketCodeForJob, PAYMENT_POLICY_VERSION, resolvePaymentPolicy } from "@/lib/payments/policy";

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
 *
 * Pay before dispatch — VASRUE Digital Media, 29 October 2026 (Carl's
 * work order, Correction A; payment spec §3). The intent now COLLECTS the
 * full approved amount at booking (automatic capture), card only unless ACH
 * is switched on and there is lead time. It used to authorise here and
 * capture after the customer approved the finished job. The accepted quote
 * is snapshotted as an immutable QuoteVersion, and a FundingAttempt row
 * tracks the intent; the job reaches the marketplace only when the webhook
 * confirms the money was collected.
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
  if (job.status === "CANCELED") return NextResponse.json({ error: "This booking was canceled." }, { status: 409 });

  if (job.stripePaymentIntentId && job.paymentStatus !== "FAILED" && job.paymentStatus !== "CANCELED") {
    // BLOCK-19 — VASRUE Digital Media, 28 Oct 2026: a first attempt that never
    // reached the bank leaves the intent waiting for a card; hand it back so
    // the customer can finish paying. See lib/stripe-intent-reuse.ts.
    const reusable = await findReusableIntent(job.stripePaymentIntentId, job.estimatedTotalCents);
    if (reusable && reusable.capture_method !== "manual") {
      return NextResponse.json({ clientSecret: reusable.client_secret, paymentIntentId: reusable.id, totalCents: job.estimatedTotalCents, attemptNumber: null, reused: true });
    }
    if (reusable) {
      // An unpaid intent from the old authorise-then-capture flow: retire it
      // and collect under the new policy instead. Nothing was ever charged.
      await stripe.paymentIntents.cancel(reusable.id, { cancellation_reason: "abandoned" }).catch(() => undefined);
      await prisma.paymentAttempt.updateMany({ where: { stripePaymentIntentId: reusable.id }, data: { paymentStatus: "CANCELED", canceledAt: new Date(), cancelReason: "Replaced under pay-before-dispatch" } });
    } else {
      return NextResponse.json({ error: job.paymentStatus === "CAPTURED" ? "This booking is already paid." : "Existing payment must be resolved first." }, { status: 409 });
    }
  }
  const stripeCustomerId = await ensureStripeCustomer(prisma, job.customerId);

  const policy = await resolvePaymentPolicy(await marketCodeForJob(job));
  const quote = await ensureQuoteVersion(
    { type: "JOB", id: job.id },
    {
      totalCents: job.estimatedTotalCents,
      lines: [
        { label: "Service", cents: job.estimatedSubtotalCents },
        { label: "Platform fee", cents: job.estimatedPlatformFeeCents },
        ...(job.urgentPremiumCents ? [{ label: "Urgent booking", cents: job.urgentPremiumCents }] : []),
        { label: "Booking protection", cents: job.bookingProtectionFeeCents },
      ],
      plan: { jobType: job.type, movers: job.moversRequired, estimatedHours: Number(job.estimatedHours), minimumHours: job.minimumHours, customerMoverRateCents: job.customerMoverRateCents, platformFeePerHourCents: job.platformFeePerHourCents },
    },
    authed.userId,
  );

  const attempt = await claimNextPaymentAttempt({ jobId: job.id }, "job-payment-intent");

  let intent;
  try {
    intent = await stripe.paymentIntents.create(
      {
        amount: job.estimatedTotalCents,
        currency: "usd",
        customer: stripeCustomerId,
        capture_method: "automatic",
        payment_method_types: fundingPaymentMethodTypes({ achEnabled: policy.achEnabled, startsAt: job.startsAt }),
        description: `TempMovers booking ${job.id}`,
        metadata: {
          jobId: job.id, attemptNumber: String(attempt.attemptNumber),
          policyVersion: PAYMENT_POLICY_VERSION, quoteVersion: String(quote.version), purpose: "JOB_FUNDING",
          movers: String(job.moversRequired),
          billableHours: String(job.estimatedHours),
          customerMoverRateCents: String(job.customerMoverRateCents),
          platformFeePerManHourCents: String(job.platformFeePerHourCents),
          bookingProtectionFeeCents: String(job.bookingProtectionFeeCents),
        },
      },
      { idempotencyKey: `${attempt.idempotencyKey}:pbd` },
    );
  } catch (error) {
    await markAttemptFailed(attempt.id, error instanceof Error ? error.message : "Unknown Stripe error");
    return NextResponse.json({ error: "Failed to create PaymentIntent." }, { status: 502 });
  }

  const status = mapStripeIntentStatus(intent.status);

  // Persist the intent ID on the job now — this is what lets the webhook's
  // payment_intent.succeeded/payment_failed handlers find and update this
  // job. Status is derived from the intent's actual state, never asserted.
  await prisma.$transaction([
    prisma.job.update({ where: { id: job.id }, data: { stripePaymentIntentId: intent.id, paymentStatus: status } }),
    prisma.fundingAttempt.create({
      data: {
        entityType: "JOB", entityId: job.id, purpose: "INITIAL", quoteVersionId: quote.id,
        stripePaymentIntentId: intent.id, amountCents: job.estimatedTotalCents, state: "UNPAID",
      },
    }),
  ]);
  await markAttemptCreated(attempt.id, intent.id, status);

  return NextResponse.json({
    clientSecret: intent.client_secret,
    paymentIntentId: intent.id,
    totalCents: job.estimatedTotalCents,
    attemptNumber: attempt.attemptNumber,
    collectNow: true,
  });
}
