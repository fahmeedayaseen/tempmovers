import { NextResponse } from "next/server";
import { stripe } from "@/lib/stripe";
import { prisma } from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";
import { captureIntegrationAlert } from "@/lib/monitoring";
import { queueNotification } from "@/lib/notifications";
import { payoutStatusTemplate } from "@/lib/email/templates/payments";

/**
 * Pays a tip allocation via a real Stripe Transfer to the worker's
 * connected account — mirrors
 * app/api/settlements/[settlementId]/pay/route.ts closely (same
 * eligibility checks, same TRANSFERRED-not-PAID_OUT distinction, same
 * idempotency-key-survives-retries approach, same no-separate-
 * operation-table reasoning: a tip allocation has no bonus-recovery
 * concept at all, so its own idempotencyKey field doubles as both the
 * atomic claim marker and the Stripe idempotency key, same as
 * Settlement).
 */
export async function POST(request: Request, context: { params: Promise<{ allocationId: string }> }) {
  let authed;
  try {
    authed = await requireRole(request, ["ADMIN"]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  const { allocationId } = await context.params;

  const allocation = await prisma.tipAllocation.findUnique({ where: { id: allocationId }, include: { worker: true } });
  if (!allocation) return NextResponse.json({ error: "Tip allocation not found." }, { status: 404 });
  if (allocation.status === "TRANSFERRED" || allocation.status === "PAID_OUT") {
    return NextResponse.json({ error: "Already paid." }, { status: 409 });
  }
  if (allocation.status === "REVERSED") return NextResponse.json({ error: "This tip allocation was reversed." }, { status: 409 });
  if (allocation.status === "HELD") return NextResponse.json({ error: "This tip allocation is on hold." }, { status: 409 });

  // Reconcile a PROCESSING allocation by checking Stripe directly for a
  // transfer matching this allocation's ID in metadata — same
  // transfer-list fallback the settlement route uses for the same
  // no-operation-table reason.
  if (allocation.status === "PROCESSING") {
    const transfers = await stripe.transfers.list({ limit: 100 });
    const matched = transfers.data.find((t) => t.metadata?.tipAllocationId === allocation.id);
    if (matched) {
      const reconciled = await prisma.tipAllocation.update({
        where: { id: allocation.id },
        data: { stripeTransferId: matched.id, status: "TRANSFERRED", paidAt: new Date() },
      });
      await prisma.auditLog.create({
        data: { actorId: authed.userId, action: "TIP_ALLOCATION_RECONCILED", entityType: "TipAllocation", entityId: allocation.id, details: { stripeTransferId: matched.id } },
      });
      return NextResponse.json({ allocation: reconciled, transferred: true, reconciled: true });
    }
    captureIntegrationAlert("Tip allocation stuck PROCESSING with no matching Stripe transfer found.", { area: "payout", tipAllocationId: allocation.id });
    return NextResponse.json({
      error: "This tip allocation is PROCESSING with no matching Stripe transfer found in recent history. Investigate manually before retrying — do not assume it's safe to resubmit.",
    }, { status: 409 });
  }

  if (allocation.status !== "PENDING" && allocation.status !== "FAILED") {
    return NextResponse.json({ error: `Tip allocation status ${allocation.status} is not payable.` }, { status: 409 });
  }
  if (!allocation.worker.stripeAccountId || !allocation.worker.stripePayoutsEnabled) {
    return NextResponse.json({ error: "Worker has not completed Stripe Connect onboarding." }, { status: 409 });
  }
  if (allocation.worker.operationalStatus === "SUSPENDED" || allocation.worker.operationalStatus === "CLOSED") {
    return NextResponse.json({ error: `Worker account is ${allocation.worker.operationalStatus.toLowerCase()} — tip payout blocked pending review.` }, { status: 409 });
  }
  if (allocation.amountCents <= 0) {
    return NextResponse.json({ error: "Tip allocation amount is zero or negative — nothing to transfer." }, { status: 409 });
  }

  const isRetry = allocation.status === "FAILED";
  const idempotencyKey = `tip-allocation:${allocation.id}`;

  const claim = await prisma.tipAllocation.updateMany({
    where: { id: allocation.id, status: isRetry ? "FAILED" : "PENDING" },
    data: { status: "PROCESSING", idempotencyKey },
  });
  if (claim.count === 0) {
    return NextResponse.json({ error: "Tip allocation payout already in progress or completed." }, { status: 409 });
  }

  let transfer;
  try {
    transfer = await stripe.transfers.create(
      {
        amount: allocation.amountCents,
        currency: "usd",
        destination: allocation.worker.stripeAccountId,
        metadata: { tipAllocationId: allocation.id, tipId: allocation.tipId, workerId: allocation.workerId },
      },
      { idempotencyKey },
    );
  } catch (error) {
    const failureReason = error instanceof Error ? error.message : "Stripe transfer failed";
    await prisma.tipAllocation.update({
      where: { id: allocation.id },
      data: { status: "FAILED", failedAt: new Date(), failureReason },
    });
    await prisma.auditLog.create({
      data: { actorId: authed.userId, action: "TIP_ALLOCATION_TRANSFER_FAILED", entityType: "TipAllocation", entityId: allocation.id, details: { error: failureReason, isRetry } },
    });
    captureIntegrationAlert("Tip allocation Stripe transfer failed.", { area: "payout", tipAllocationId: allocation.id, error: failureReason });
    return NextResponse.json({ error: "Stripe transfer failed. This tip allocation can be retried." }, { status: 502 });
  }

  // TRANSFERRED, not PAID_OUT — same distinction as every other payout
  // in this system: confirms movement to the worker's Connect balance,
  // not confirmed arrival in their bank account.
  const updated = await prisma.tipAllocation.update({
    where: { id: allocation.id },
    data: { stripeTransferId: transfer.id, status: "TRANSFERRED", paidAt: new Date() },
  });

  await prisma.auditLog.create({
    data: { actorId: authed.userId, action: "TIP_ALLOCATION_TRANSFERRED", entityType: "TipAllocation", entityId: allocation.id, details: { stripeTransferId: transfer.id, amountCents: allocation.amountCents, wasRetry: isRetry } },
  });

  const notice = payoutStatusTemplate({ workerName: allocation.worker.displayName ?? "there", status: "TRANSFERRED", netPayoutCents: allocation.amountCents });
  await queueNotification({
    userId: allocation.worker.userId, type: "PAYOUT_STATUS", channels: ["EMAIL", "IN_APP"],
    title: notice.subject, body: notice.text, html: notice.html, idempotencyKey: `tip-allocation-transferred:${allocation.id}`,
  });

  return NextResponse.json({ allocation: updated, transferred: true });
}
