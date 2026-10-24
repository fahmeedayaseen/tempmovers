import { NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { z } from "zod";
import { stripe } from "@/lib/stripe";
import { prisma } from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";
import { captureIntegrationAlert } from "@/lib/monitoring";

/**
 * P1-05: the missing creation half of the refund lifecycle. The
 * charge.refunded webhook (see app/api/stripe/webhook/route.ts) only
 * ever reconciled a refund that already happened in Stripe — there was
 * no authorized, auditable path for an admin to actually INITIATE one.
 *
 * Unified across jobs and freight loads, since both now share
 * PaymentTransaction as their authoritative payment record.
 *
 * Never marks Job/CarrierRoute REFUNDED optimistically here — the
 * webhook remains the sole authority for that, exactly as it already is
 * for capture. This route's job ends at "successfully submitted to
 * Stripe," not "confirmed refunded."
 */
const schema = z.object({
  amountCents: z.number().int().positive().optional(),
  fullRefund: z.boolean().default(false),
  reason: z.string().trim().min(1, "A refund reason is required."),
});

export async function POST(request: Request, context: { params: Promise<{ transactionId: string }> }) {
  let authed;
  try {
    authed = await requireRole(request, ["ADMIN"]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  const { transactionId } = await context.params;

  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  if (!parsed.data.fullRefund && parsed.data.amountCents === undefined) {
    return NextResponse.json({ error: "amountCents is required unless fullRefund is true." }, { status: 400 });
  }

  const transaction = await prisma.paymentTransaction.findUnique({ where: { id: transactionId } });
  if (!transaction) return NextResponse.json({ error: "Payment transaction not found." }, { status: 404 });
  if (!transaction.jobId && !transaction.loadId) {
    return NextResponse.json({ error: "This payment transaction is not attached to exactly one job or load." }, { status: 409 });
  }
  if (!transaction.stripeChargeId || !transaction.stripePaymentIntentId) {
    return NextResponse.json({ error: "No authoritative Stripe charge/PaymentIntent exists for this transaction." }, { status: 409 });
  }

  let claim;
  try {
    claim = await prisma.$transaction(async (tx) => {
      // Sum SUCCEEDED + PENDING/PROCESSING reservations — the refundable
      // balance must account for refunds already in flight, not just
      // ones that have already succeeded, or two concurrent requests
      // could each see the full balance as available.
      const reserved = await tx.paymentRefund.aggregate({
        where: { paymentTransactionId: transaction.id, status: { in: ["SUCCEEDED", "PENDING", "PROCESSING"] } },
        _sum: { amountCents: true },
      });
      const reservedCents = reserved._sum.amountCents ?? 0;
      const refundableRemainingCents = transaction.amountReceivedCents - reservedCents;

      const requestedCents = parsed.data.fullRefund ? refundableRemainingCents : parsed.data.amountCents!;

      if (requestedCents <= 0) {
        throw new Error("INVALID_AMOUNT");
      }
      if (requestedCents > refundableRemainingCents) {
        throw new Error("EXCEEDS_BALANCE");
      }

      // Generate the row's own identity FIRST, then derive the
      // idempotency key from it — not the other way around. The
      // previous version embedded Date.now() directly in the key, which
      // meant a client retry (e.g. after a network timeout where Stripe
      // actually succeeded but the response never reached the caller)
      // would compute a brand-new key on the next attempt and cause
      // Stripe to process a genuinely second, separate refund — exactly
      // defeating what an idempotency key exists to prevent. This
      // mirrors a P0 fix made elsewhere in this same codebase (Stripe
      // Checkout idempotency) several rounds back.
      const refundId = randomUUID();
      const idempotencyKey = `refund:${refundId}`;
      const refund = await tx.paymentRefund.create({
        data: {
          id: refundId,
          paymentTransactionId: transaction.id,
          idempotencyKey,
          amountCents: requestedCents,
          currency: transaction.currency,
          status: "PROCESSING",
          reason: parsed.data.reason,
          requestedByUserId: authed.userId,
        },
      });

      await tx.auditLog.create({
        data: {
          actorId: authed.userId, action: "REFUND_REQUESTED", entityType: "PaymentRefund", entityId: refund.id,
          details: {
            transactionId: transaction.id, jobId: transaction.jobId, loadId: transaction.loadId,
            requestedAmountCents: requestedCents, remainingBalanceBeforeCents: refundableRemainingCents,
            reason: parsed.data.reason, idempotencyKey,
          },
        },
      });

      return { refund, refundableRemainingCents: refundableRemainingCents - requestedCents };
    }, { isolationLevel: "Serializable" });
  } catch (error) {
    if (error instanceof Error && error.message === "INVALID_AMOUNT") {
      return NextResponse.json({ error: "Refund amount must be greater than zero." }, { status: 400 });
    }
    if (error instanceof Error && error.message === "EXCEEDS_BALANCE") {
      return NextResponse.json({ error: "Refund amount exceeds the remaining refundable balance." }, { status: 409 });
    }
    // A serialization failure from the Serializable isolation level means
    // a concurrent request raced this one — safely retryable, not a bug.
    return NextResponse.json({ error: "Could not claim this refund due to a concurrent request. This is safely retryable." }, { status: 409 });
  }

  let stripeRefund;
  try {
    stripeRefund = await stripe.refunds.create(
      { charge: transaction.stripeChargeId, amount: claim.refund.amountCents, reason: "requested_by_customer" },
      { idempotencyKey: claim.refund.idempotencyKey },
    );
  } catch (error) {
    const failureMessage = error instanceof Error ? error.message : "Unknown Stripe error";
    await prisma.paymentRefund.update({
      where: { id: claim.refund.id },
      data: { status: "FAILED", failureMessage, failedAt: new Date() },
    });
    await prisma.auditLog.create({
      data: { actorId: authed.userId, action: "REFUND_FAILED", entityType: "PaymentRefund", entityId: claim.refund.id, details: { amountCents: claim.refund.amountCents, reason: claim.refund.reason, failureMessage, result: "FAILED" } },
    });
    captureIntegrationAlert("Refund submission to Stripe failed.", { area: "payment", refundId: claim.refund.id, error: failureMessage });
    return NextResponse.json({ error: `Refund failed: ${failureMessage}` }, { status: 502 });
  }

  const status = stripeRefund.status === "succeeded" ? "SUCCEEDED" : stripeRefund.status === "failed" ? "FAILED" : "PENDING";
  const updated = await prisma.paymentRefund.update({
    where: { id: claim.refund.id },
    data: {
      stripeRefundId: stripeRefund.id, status,
      succeededAt: status === "SUCCEEDED" ? new Date() : null,
      failedAt: status === "FAILED" ? new Date() : null,
    },
  });

  await prisma.auditLog.create({
    data: {
      actorId: authed.userId, action: "REFUND_SUBMITTED_TO_STRIPE", entityType: "PaymentRefund", entityId: updated.id,
      details: { stripeRefundId: stripeRefund.id, status, amountCents: updated.amountCents, reason: updated.reason, result: status },
    },
  });

  return NextResponse.json({
    refundId: updated.id, status: updated.status, amountCents: updated.amountCents,
    refundableRemainingCents: claim.refundableRemainingCents,
  });
}
