import { NextResponse } from "next/server";
import { stripe } from "@/lib/stripe";
import { prisma } from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";
import { captureIntegrationAlert } from "@/lib/monitoring";
import { queueNotification } from "@/lib/notifications";
import { payoutStatusTemplate } from "@/lib/email/templates/payments";

/**
 * Pays an approved settlement via a real Stripe Transfer to the driver's
 * connected account — mirrors app/api/payouts/[payoutId]/pay/route.ts's
 * structure closely (same eligibility checks, same TRANSFERRED-not-
 * PAID_OUT distinction, same idempotency-key-survives-retries approach),
 * adapted for a settlement's simpler lifecycle: no bonus-recovery
 * reservation applies here (that's specific to moving-job worker
 * payouts), so no PayoutOperation-style intermediate ledger is needed —
 * Settlement.idempotencyKey itself doubles as both the atomic claim
 * marker and the Stripe idempotency key.
 */
export async function POST(request: Request, context: { params: Promise<{ settlementId: string }> }) {
  let authed;
  try {
    authed = await requireRole(request, ["ADMIN"]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  const { settlementId } = await context.params;

  const settlement = await prisma.settlement.findUnique({ where: { id: settlementId }, include: { worker: true } });
  if (!settlement) return NextResponse.json({ error: "Settlement not found." }, { status: 404 });
  if (settlement.status === "TRANSFERRED" || settlement.status === "PAID_OUT") {
    return NextResponse.json({ error: "Already paid." }, { status: 409 });
  }
  if (settlement.status === "REVERSED") return NextResponse.json({ error: "This settlement was reversed." }, { status: 409 });
  if (settlement.status === "HELD") return NextResponse.json({ error: "This settlement is on hold." }, { status: 409 });

  // Reconcile a PROCESSING settlement by checking Stripe directly for a
  // transfer matching this settlement's ID in metadata — there's no
  // dedicated operation-ledger table for settlements (see docblock), so
  // this is the same transfer-list fallback the payout route uses when
  // it has no PayoutOperation record to check first.
  if (settlement.status === "PROCESSING") {
    const transfers = await stripe.transfers.list({ limit: 100 });
    const matched = transfers.data.find((t) => t.metadata?.settlementId === settlement.id);
    if (matched) {
      const reconciled = await prisma.settlement.update({
        where: { id: settlement.id },
        data: { stripeTransferId: matched.id, status: "TRANSFERRED", paidAt: new Date() },
      });
      await prisma.auditLog.create({
        data: { actorId: authed.userId, action: "SETTLEMENT_RECONCILED", entityType: "Settlement", entityId: settlement.id, details: { stripeTransferId: matched.id } },
      });
      return NextResponse.json({ settlement: reconciled, transferred: true, reconciled: true });
    }
    captureIntegrationAlert("Settlement stuck PROCESSING with no matching Stripe transfer found.", { area: "payout", settlementId: settlement.id });
    return NextResponse.json({
      error: "This settlement is PROCESSING with no matching Stripe transfer found in recent history. Investigate manually before retrying — do not assume it's safe to resubmit.",
    }, { status: 409 });
  }

  if (settlement.status !== "SCHEDULED" && settlement.status !== "FAILED") {
    return NextResponse.json({ error: `Settlement status ${settlement.status} is not payable — it must be approved (SCHEDULED) first.` }, { status: 409 });
  }
  if (!settlement.worker.stripeAccountId || !settlement.worker.stripePayoutsEnabled) {
    return NextResponse.json({ error: "Worker has not completed Stripe Connect onboarding." }, { status: 409 });
  }
  if (settlement.worker.operationalStatus === "SUSPENDED" || settlement.worker.operationalStatus === "CLOSED") {
    return NextResponse.json({ error: `Worker account is ${settlement.worker.operationalStatus.toLowerCase()} — settlement payout blocked pending review.` }, { status: 409 });
  }
  if (settlement.netCents <= 0) {
    return NextResponse.json({ error: "Settlement net amount is zero or negative — nothing to transfer." }, { status: 409 });
  }

  const isRetry = settlement.status === "FAILED";
  const idempotencyKey = `settlement:${settlement.id}`;

  // Atomic claim before calling Stripe — same reasoning as the job-capture
  // route's claim: a plain read-then-write check here leaves a real race
  // window between two concurrent pay requests.
  const claim = await prisma.settlement.updateMany({
    where: { id: settlement.id, status: isRetry ? "FAILED" : "SCHEDULED" },
    data: { status: "PROCESSING", idempotencyKey },
  });
  if (claim.count === 0) {
    return NextResponse.json({ error: "Settlement payout already in progress or completed." }, { status: 409 });
  }

  let transfer;
  try {
    transfer = await stripe.transfers.create(
      {
        amount: settlement.netCents,
        currency: "usd",
        destination: settlement.worker.stripeAccountId,
        metadata: { settlementId: settlement.id, workerId: settlement.workerId },
      },
      { idempotencyKey },
    );
  } catch (error) {
    const failureReason = error instanceof Error ? error.message : "Stripe transfer failed";
    await prisma.settlement.update({
      where: { id: settlement.id },
      data: { status: "FAILED", failedAt: new Date(), failureReason },
    });
    await prisma.auditLog.create({
      data: { actorId: authed.userId, action: "SETTLEMENT_TRANSFER_FAILED", entityType: "Settlement", entityId: settlement.id, details: { error: failureReason, isRetry } },
    });
    captureIntegrationAlert("Settlement Stripe transfer failed.", { area: "payout", settlementId: settlement.id, error: failureReason });
    return NextResponse.json({ error: "Stripe transfer failed. This settlement can be retried." }, { status: 502 });
  }

  // TRANSFERRED, not PAID_OUT — same distinction as the payout route:
  // this confirms movement to the driver's Connect account balance, not
  // confirmed arrival in their bank account.
  const [updated] = await prisma.$transaction([
    prisma.settlement.update({
      where: { id: settlement.id },
      data: { stripeTransferId: transfer.id, status: "TRANSFERRED", paidAt: new Date() },
    }),
    // includedInPayoutAt now genuinely means "paid out" — set here, not
    // at generation, where SettlementDetentionLine's own existence
    // already tracks "claimed by this settlement."
    prisma.detentionCharge.updateMany({
      where: { settlementLine: { settlementId: settlement.id } },
      data: { includedInPayoutAt: new Date() },
    }),
  ]);

  await prisma.auditLog.create({
    data: { actorId: authed.userId, action: "SETTLEMENT_TRANSFERRED", entityType: "Settlement", entityId: settlement.id, details: { stripeTransferId: transfer.id, netCents: settlement.netCents, wasRetry: isRetry } },
  });

  const notice = payoutStatusTemplate({ workerName: settlement.worker.displayName ?? "there", status: "TRANSFERRED", netPayoutCents: settlement.netCents });
  await queueNotification({
    userId: settlement.worker.userId, type: "PAYOUT_STATUS", channels: ["EMAIL", "IN_APP"],
    title: notice.subject, body: notice.text, html: notice.html, idempotencyKey: `settlement-transferred:${settlement.id}`,
  });

  return NextResponse.json({ settlement: updated, transferred: true });
}
