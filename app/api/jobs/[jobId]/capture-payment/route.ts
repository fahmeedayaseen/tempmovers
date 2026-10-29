import { NextResponse } from "next/server";
import { stripe } from "@/lib/stripe";
import { prisma } from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";
import { runJobCompletionBonusGenerators } from "@/lib/bonus-generators";
import { captureIntegrationAlert } from "@/lib/monitoring";
import { queueNotification } from "@/lib/notifications";
import { reviewRequestTemplate } from "@/lib/email/templates/documents";
import { calculateJobFinalCaptureAmount } from "@/lib/capture-preview";
import { isPayBeforeDispatchJob, settleJob, SettlementError } from "@/lib/payments/settlement";

/**
 * Captures a job's already-authorized PaymentIntent — but for the FINAL
 * approved amount, computed from actual assignment hours, not the
 * original booking estimate. Previously this called
 * stripe.paymentIntents.capture(id, {}) with an empty body, which
 * captures the ENTIRE authorized amount regardless of what actually
 * happened on the job — a customer could be over- or under-charged
 * relative to the hours a mover actually worked and the customer
 * actually approved.
 *
 * Billable assignments are those that reached CHECKED_OUT or APPROVED —
 * a worker who was invited/applied/accepted but never started, or who
 * was declined/canceled/no-showed, never did billable work and must not
 * block capture just because their row exists on the job. Every
 * assignment that DID reach that point must be customer-approved with
 * actualHours recorded before capture can proceed — capturing before
 * that would recreate the exact problem this fix addresses, just at the
 * validation layer instead of the calculation layer.
 */
export async function POST(request: Request, context: { params: Promise<{ jobId: string }> }) {
  let authed;
  try {
    authed = await requireRole(request, ["ADMIN"]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  const { jobId } = await context.params;

  const job = await prisma.job.findUnique({ where: { id: jobId } });
  if (!job) return NextResponse.json({ error: "Job not found." }, { status: 404 });

  // Pay before dispatch — VASRUE Digital Media, 29 Oct 2026: the money on a
  // prepaid job was collected at booking, so there is nothing to capture. The
  // same admin action settles it instead (lib/payments/settlement.ts).
  if (await isPayBeforeDispatchJob(job.id)) {
    try {
      const outcome = await settleJob(job.id, authed.userId);
      return NextResponse.json({ settled: true, ...outcome });
    } catch (e) {
      if (e instanceof SettlementError) return NextResponse.json({ error: e.message }, { status: e.status });
      throw e;
    }
  }
  if (job.status !== "COMPLETED") {
    return NextResponse.json({ error: "The job must be completed and approved before payment capture." }, { status: 409 });
  }
  if (!job.stripePaymentIntentId) {
    return NextResponse.json({ error: "This job has no associated PaymentIntent to capture." }, { status: 409 });
  }
  if (job.paymentStatus === "CAPTURED") {
    return NextResponse.json({ error: "Already captured." }, { status: 409 });
  }

  // Atomically claim the right to capture BEFORE calling Stripe — a plain
  // read-then-write check here would leave a real race window where two
  // concurrent requests both read "not yet captured" and both proceed to
  // call Stripe. This update only succeeds (count > 0) for whichever
  // request gets there first; capturedAt doubles as the claim marker and
  // gets reset if the Stripe call itself throws below, so a genuine retry
  // after a transient failure isn't permanently locked out.
  const claim = await prisma.job.updateMany({
    where: { id: job.id, capturedAt: null, paymentStatus: { not: "CAPTURED" } },
    data: { capturedAt: new Date() },
  });
  if (claim.count === 0) {
    return NextResponse.json({ error: "Capture already in progress or completed for this job." }, { status: 409 });
  }

  const preview = await calculateJobFinalCaptureAmount(prisma, job);
  if (!preview.ok) {
    // Release the claim — this job isn't actually ready, so the claim
    // above shouldn't permanently block a future attempt once it is.
    await prisma.job.update({ where: { id: job.id }, data: { capturedAt: null } });
    return NextResponse.json({ error: preview.reason }, { status: 409 });
  }
  const { finalLaborCents, finalPlatformFeeCents, finalTotalCents, billableAssignments } = preview;

  let intent;
  try {
    intent = await stripe.paymentIntents.capture(
      job.stripePaymentIntentId,
      { amount_to_capture: finalTotalCents },
      { idempotencyKey: `job-capture:${job.id}:${finalTotalCents}` },
    );
  } catch (error) {
    // Release the claim — this was a genuine failure to reach/complete
    // the Stripe call, not a successful capture. Without this, the claim
    // from above would permanently block any future retry of this job.
    await prisma.job.update({ where: { id: job.id }, data: { capturedAt: null } });
    captureIntegrationAlert("Job capture failed at the Stripe call.", {
      area: "payout", jobId: job.id, error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ error: "Payment capture failed. The claim has been released; this can be retried." }, { status: 502 });
  }

  // The webhook is the authoritative source for the final paymentStatus (it
  // reacts to what Stripe actually confirms), but we optimistically reflect
  // AUTHORIZED -> CAPTURED here too so the UI doesn't have to wait on webhook
  // latency to show the right state. finalTotalCents etc. are persisted
  // regardless of that race, since they're computed from our own data, not
  // from Stripe's response.
  const updated = await prisma.job.update({
    where: { id: job.id },
    data: {
      paymentStatus: intent.status === "succeeded" ? "CAPTURED" : job.paymentStatus,
      finalLaborCents, finalPlatformFeeCents, finalTotalCents,
      capturedAmountCents: intent.status === "succeeded" ? finalTotalCents : null,
      authorizedAmountCents: job.estimatedTotalCents,
      capturedAt: intent.status === "succeeded" ? new Date() : null,
      pricingSnapshot: {
        estimatedTotalCents: job.estimatedTotalCents,
        finalLaborCents, finalPlatformFeeCents, finalTotalCents,
        urgentPremiumCents: job.urgentPremiumCents, bookingProtectionFeeCents: job.bookingProtectionFeeCents,
        assignments: billableAssignments.map((a) => ({ id: a.id, workerId: a.workerId, scheduledHours: a.scheduledHours, actualHours: a.actualHours, agreedEarningsCents: a.agreedEarningsCents })),
      },
    },
  });

  await prisma.auditLog.create({
    data: { actorId: authed.userId, action: "JOB_PAYMENT_CAPTURED", entityType: "Job", entityId: job.id, details: { paymentIntentId: intent.id, status: intent.status, finalTotalCents, estimatedTotalCents: job.estimatedTotalCents } },
  });

  // Capture succeeding is the actual "completed, paid, non-refunded" moment
  // that customer/mover/referral bonuses key off — not job completion
  // alone, which can happen before payment ever clears.
  //
  // Wrapped deliberately: the Stripe capture above already succeeded by
  // this point. A bug or transient failure in bonus generation must never
  // turn an already-successful payment capture into a 500 response — that
  // would tell the caller the capture failed when it didn't. Alert instead
  // of throwing, so this doesn't fail silently either.
  if (intent.status === "succeeded") {
    try {
      const approvedAssignments = await prisma.assignment.findMany({
        where: { jobId: job.id, status: "APPROVED" },
        select: { workerId: true },
      });
      await runJobCompletionBonusGenerators(
        prisma,
        { id: updated.id, customerId: updated.customerId, status: updated.status },
        approvedAssignments.map((a) => a.workerId),
      );
    } catch (error) {
      captureIntegrationAlert("Payment captured but bonus-generation accounting failed.", {
        area: "payout", jobId: job.id, error: error instanceof Error ? error.message : String(error),
      });
    }

    const customer = await prisma.customerProfile.findUnique({ where: { id: updated.customerId }, select: { userId: true, user: { select: { firstName: true } } } });
    if (customer) {
      // Receipt is no longer sent from here — see the webhook's
      // payment_intent.succeeded handler (createPaymentTransactionAndSendReceipt),
      // which is now the authoritative source: it uses Stripe's own
      // confirmed charge/payment-method data, not this route's own
      // computed finalTotalCents, and only fires once Stripe has actually
      // confirmed the capture, not optimistically alongside it.
      const reviewRequest = reviewRequestTemplate({ customerName: customer.user.firstName, jobTitle: updated.title, jobId: updated.id });
      await queueNotification({
        userId: customer.userId, type: "REVIEW_REQUEST", channels: ["EMAIL", "IN_APP"],
        title: reviewRequest.subject, body: reviewRequest.text, html: reviewRequest.html, idempotencyKey: `review-request:${job.id}`,
      });
    }
  }

  return NextResponse.json({ job: updated, paymentIntentStatus: intent.status, finalTotalCents });
}
