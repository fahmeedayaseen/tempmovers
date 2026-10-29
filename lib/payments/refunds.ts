import { prisma } from "@/lib/db";
import { stripe } from "@/lib/stripe";
import { captureIntegrationAlert } from "@/lib/monitoring";
import type { FundingRef } from "@/lib/payments/funding";

// ---------------------------------------------------------------------------
// Policy refunds — VASRUE Digital Media, 29 October 2026.
//
// Refunds the platform owes under pay-before-dispatch: unused disposal and
// helper time at settlement, and the full amount when a booking is canceled
// before dispatch (payment spec §6–§7). The whole difference goes back to the
// customer; Stripe's processing cost stays a platform expense, never netted.
//
// Spread across the booking's payments newest first. Every refund row has a
// deterministic idempotency key built from the caller's purpose and the
// payment, so a retried settlement or a double click can never refund twice;
// it finds the earlier row and stops.
// ---------------------------------------------------------------------------

export type PolicyRefundResult = { requestedCents: number; refundedCents: number; refunds: { id: string; amountCents: number; status: string }[]; failures: string[] };

export async function refundCollectedFunds(input: { ref: FundingRef; amountCents: number; reason: string; purposeKey: string; actorUserId: string }): Promise<PolicyRefundResult> {
  const out: PolicyRefundResult = { requestedCents: input.amountCents, refundedCents: 0, refunds: [], failures: [] };
  if (input.amountCents <= 0) return out;
  if (input.ref.type === "FREIGHT_LOAD") {
    out.failures.push("Freight loads are invoiced; refund them through the invoice.");
    return out;
  }

  const transactions = await prisma.paymentTransaction.findMany({
    where: input.ref.type === "JOB" ? { jobId: input.ref.id } : { loadId: input.ref.id },
    orderBy: { createdAt: "desc" },
  });
  if (transactions.length === 0) {
    out.failures.push("No collected payment is on record yet; the refund will be retried.");
    return out;
  }

  let remaining = input.amountCents;
  for (const tx of transactions) {
    if (remaining <= 0) break;
    const idempotencyKey = `${input.purposeKey}:${tx.id}`;
    const existing = await prisma.paymentRefund.findUnique({ where: { idempotencyKey } });
    if (existing && existing.status !== "FAILED" && existing.status !== "CANCELED") {
      out.refundedCents += existing.amountCents;
      out.refunds.push({ id: existing.id, amountCents: existing.amountCents, status: existing.status });
      remaining -= existing.amountCents;
      continue;
    }

    const reserved = await prisma.paymentRefund.aggregate({
      where: { paymentTransactionId: tx.id, status: { in: ["SUCCEEDED", "PENDING", "PROCESSING"] } },
      _sum: { amountCents: true },
    });
    const refundable = tx.amountReceivedCents - (reserved._sum.amountCents ?? 0);
    const amount = Math.min(remaining, refundable);
    if (amount <= 0) continue;

    const row = existing
      ? await prisma.paymentRefund.update({ where: { id: existing.id }, data: { amountCents: amount, status: "PROCESSING", failureMessage: null, failedAt: null } })
      : await prisma.paymentRefund.create({
          data: { paymentTransactionId: tx.id, idempotencyKey, amountCents: amount, currency: tx.currency, status: "PROCESSING", reason: input.reason, requestedByUserId: input.actorUserId },
        });

    try {
      const refund = await stripe.refunds.create(
        { charge: tx.stripeChargeId, amount, metadata: { purpose: input.purposeKey, entityType: input.ref.type, entityId: input.ref.id } },
        { idempotencyKey: `${idempotencyKey}:${amount}` },
      );
      const status = refund.status === "succeeded" ? "SUCCEEDED" : refund.status === "failed" ? "FAILED" : "PENDING";
      await prisma.paymentRefund.update({
        where: { id: row.id },
        data: { stripeRefundId: refund.id, status, succeededAt: status === "SUCCEEDED" ? new Date() : null, failedAt: status === "FAILED" ? new Date() : null },
      });
      out.refunds.push({ id: row.id, amountCents: amount, status });
      if (status !== "FAILED") { out.refundedCents += amount; remaining -= amount; }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      await prisma.paymentRefund.update({ where: { id: row.id }, data: { status: "FAILED", failureMessage: message, failedAt: new Date() } });
      out.failures.push(message);
      captureIntegrationAlert("A policy refund could not be submitted to Stripe; it will be retried.", { area: "payment", refundId: row.id, entityType: input.ref.type, entityId: input.ref.id, error: message });
    }
  }
  if (remaining > 0 && out.failures.length === 0) out.failures.push(`Only ${input.amountCents - remaining} of ${input.amountCents} cents could be refunded from the payments on record.`);

  await prisma.auditLog.create({
    data: {
      actorId: input.actorUserId, action: "POLICY_REFUND", entityType: input.ref.type === "JOB" ? "Job" : "CarrierRoute", entityId: input.ref.id,
      details: { purposeKey: input.purposeKey, reason: input.reason, requestedCents: input.amountCents, refundedCents: out.refundedCents, failures: out.failures },
    },
  });
  return out;
}
